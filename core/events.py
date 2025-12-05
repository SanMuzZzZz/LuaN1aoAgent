import asyncio
import time
from typing import Any, AsyncIterator, Dict, List, Optional


class EventBroker:
    """
    事件代理器。

    实现事件的发布订阅机制，用于Agent与Web可视化服务之间的
    实时通信。支持多订阅者、异步事件流和操作级分隔。

    Attributes:
        _queues: 存储每个操作ID对应的订阅者队列列表

    Examples:
        >>> broker = EventBroker()
        >>> await broker.emit("task.started", {"task_id": "123"}, op_id="op1")
        >>> async for event in broker.subscribe("op1"):
        ...     print(event)
    """

    def __init__(self):
        """
        初始化事件代理器。

        创建用于管理事件发布和订阅的队列字典。
        """
        self._queues: Dict[str, List[asyncio.Queue]] = {}

    def _get_subscribers(self, op_id: str) -> List[asyncio.Queue]:
        """
        获取指定操作ID的订阅者队列列表。

        Args:
            op_id: 操作ID

        Returns:
            该操作ID的订阅者队列列表
        """
        if op_id not in self._queues:
            self._queues[op_id] = []
        return self._queues[op_id]

    async def emit(self, event: str, payload: Dict[str, Any], op_id: Optional[str] = None) -> None:
        """
        发布事件到指定的订阅者。

        Args:
            event: 事件名称
            payload: 事件负载数据
            op_id: 操作ID（可选），如果指定，只发送给该操作的订阅者

        Returns:
            None
        """
        data = {
            "event": event,
            "ts": time.time(),
            "op_id": op_id,
            "payload": payload or {},
        }
        if op_id:
            for q in list(self._get_subscribers(op_id)):
                await self._safe_put(q, data)
        else:
            for subs in list(self._queues.values()):
                for q in list(subs):
                    await self._safe_put(q, data)

    async def _safe_put(self, q: asyncio.Queue, data: Dict[str, Any]) -> None:
        """
        安全地将数据放入队列。

        如果放入失败，静默处理异常以避免中断事件流。

        Args:
            q: 目标队列
            data: 要放入的数据

        Returns:
            None
        """
        try:
            await q.put(data)
        except Exception:
            pass

    async def subscribe(self, op_id: str) -> AsyncIterator[Dict[str, Any]]:
        """
        订阅指定操作ID的事件流。

        创建一个异步迭代器，持续产出该操作的事件。

        Args:
            op_id: 要订阅的操作ID

        Yields:
            事件字典，包含事件名称、时间戳、操作ID和负载数据
        """
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._get_subscribers(op_id).append(q)
        try:
            while True:
                item = await q.get()
                yield item
        except asyncio.CancelledError:
            # 正常的任务取消，静默处理
            pass
        finally:
            try:
                self._get_subscribers(op_id).remove(q)
            except ValueError:
                pass


broker = EventBroker()
