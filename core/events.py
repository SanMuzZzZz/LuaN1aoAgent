import asyncio
import time
from collections import deque
from typing import Any, AsyncIterator, Dict, List, Optional


class EventBroker:
    """
    事件代理器。

    实现事件的发布订阅机制，用于Agent与Web可视化服务之间的
    实时通信。支持多订阅者、异步事件流和操作级分隔。

    新增功能：
    - 事件缓冲：为每个 op_id 缓存最近的事件，新订阅者可以收到历史事件
    - 调试日志：帮助排查事件传递问题

    Attributes:
        _queues: 存储每个操作ID对应的订阅者队列列表
        _event_buffers: 存储每个操作ID的事件缓冲区
        _buffer_size: 每个操作ID的事件缓冲区大小

    Examples:
        >>> broker = EventBroker()
        >>> await broker.emit("task.started", {"task_id": "123"}, op_id="op1")
        >>> async for event in broker.subscribe("op1"):
        ...     print(event)
    """

    def __init__(self, buffer_size: int = 100):
        """
        初始化事件代理器。

        创建用于管理事件发布和订阅的队列字典，以及事件缓冲区。
        
        Args:
            buffer_size: 每个 op_id 的事件缓冲区大小，默认保存最近 100 条事件
        """
        self._queues: Dict[str, List[asyncio.Queue]] = {}
        self._event_buffers: Dict[str, deque] = {}
        self._buffer_size = buffer_size

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

    def _get_event_buffer(self, op_id: str) -> deque:
        """
        获取指定操作ID的事件缓冲区。

        Args:
            op_id: 操作ID

        Returns:
            该操作ID的事件缓冲区
        """
        if op_id not in self._event_buffers:
            self._event_buffers[op_id] = deque(maxlen=self._buffer_size)
        return self._event_buffers[op_id]

    async def emit(self, event: str, payload: Dict[str, Any], op_id: Optional[str] = None) -> None:
        """
        发布事件到指定的订阅者。

        事件会同时被缓存到缓冲区中，以便新订阅者可以收到历史事件。

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
            # 缓存事件到缓冲区（仅缓存 LLM 相关事件）
            if event.startswith("llm."):
                buffer = self._get_event_buffer(op_id)
                buffer.append(data)
            
            # 发送给当前订阅者
            subscribers = self._get_subscribers(op_id)
            for q in list(subscribers):
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

    async def subscribe(self, op_id: str, replay_buffered: bool = True) -> AsyncIterator[Dict[str, Any]]:
        """
        订阅指定操作ID的事件流。

        创建一个异步迭代器，持续产出该操作的事件。
        新订阅者可以选择接收缓冲区中的历史事件。

        Args:
            op_id: 要订阅的操作ID
            replay_buffered: 是否回放缓冲区中的历史事件，默认为 True

        Yields:
            事件字典，包含事件名称、时间戳、操作ID和负载数据
        """
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._get_subscribers(op_id).append(q)
        
        try:
            # 首先回放缓冲区中的历史事件
            if replay_buffered:
                buffer = self._get_event_buffer(op_id)
                if len(buffer) > 0:
                    for item in list(buffer):
                        yield item
            
            # 然后持续监听新事件
            while True:
                item = await q.get()
                yield item
        except asyncio.CancelledError:
            pass
        finally:
            try:
                self._get_subscribers(op_id).remove(q)
            except ValueError:
                pass

    def get_buffered_events(self, op_id: str) -> List[Dict[str, Any]]:
        """
        获取指定操作ID的缓冲事件列表。

        Args:
            op_id: 操作ID

        Returns:
            缓冲事件列表的副本
        """
        buffer = self._get_event_buffer(op_id)
        return list(buffer)

    def clear_buffer(self, op_id: str) -> None:
        """
        清除指定操作ID的事件缓冲区。

        Args:
            op_id: 操作ID
        """
        if op_id in self._event_buffers:
            self._event_buffers[op_id].clear()


broker = EventBroker()
