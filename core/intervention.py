import asyncio
import time
from typing import Dict, Any, Optional, Literal
from dataclasses import dataclass, field

@dataclass
class InterventionRequest:
    id: str
    op_id: str
    type: Literal["plan_approval"]
    data: Any
    created_at: float
    event: asyncio.Event = field(default_factory=asyncio.Event)
    response: Optional[Dict[str, Any]] = None

class InterventionManager:
    def __init__(self):
        # op_id -> InterventionRequest
        self.pending_requests: Dict[str, InterventionRequest] = {}

    async def request_approval(self, op_id: str, data: Any, type: str = "plan_approval") -> Dict[str, Any]:
        """
        发起审批请求并阻塞等待结果
        """
        req_id = f"req_{int(time.time())}"
        request = InterventionRequest(
            id=req_id, 
            op_id=op_id, 
            type=type, 
            data=data,
            created_at=time.time()
        )
        self.pending_requests[op_id] = request
        
        try:
            # 等待决策（没有超时，直到用户响应）
            await request.event.wait()
            return request.response
        finally:
            # 清理
            if op_id in self.pending_requests:
                del self.pending_requests[op_id]

    def get_pending_request(self, op_id: str) -> Optional[Dict[str, Any]]:
        """获取挂起的请求详情"""
        req = self.pending_requests.get(op_id)
        if req:
            return {
                "id": req.id,
                "op_id": req.op_id,
                "type": req.type,
                "data": req.data,
                "created_at": req.created_at
            }
        return None

    def submit_decision(self, op_id: str, action: str, modified_data: Any = None) -> bool:
        """
        提交决策
        action: "APPROVE", "REJECT", "MODIFY"
        """
        if op_id in self.pending_requests:
            req = self.pending_requests[op_id]
            req.response = {"action": action, "data": modified_data}
            req.event.set()
            return True
        return False

# 全局单例
intervention_manager = InterventionManager()
