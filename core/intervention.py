import asyncio
import time
from typing import Dict, Any, Optional, Literal
from dataclasses import dataclass, field
import uuid
import logging

from core.database.utils import (
    create_intervention_request,
    get_pending_intervention_request,
    update_intervention_response,
    get_intervention_request as db_get_intervention_request, # Rename to avoid conflict
)
from core.database.models import InterventionModel

# Logger for intervention manager
logger = logging.getLogger(__name__)

class InterventionManager:
    async def request_approval(self, op_id: str, data: Any, type: str = "plan_approval", timeout_seconds: int = 3600) -> Dict[str, Any]:
        """
        Agent发起审批请求，将其持久化到数据库，并阻塞等待Web UI的决策。
        """
        req_id = f"req_{int(time.time())}_{str(uuid.uuid4())[:8]}"
        
        logger.info(f"Agent {op_id}: 发起审批请求 '{req_id}', 类型: {type}")
        
        # 1. 创建数据库中的审批请求
        try:
            await create_intervention_request(req_id, op_id, type, data)
        except Exception as e:
            logger.error(f"Agent {op_id}: 创建数据库审批请求失败: {e}")
            # 如果创建失败，直接返回拒绝，避免Agent卡死
            return {"action": "REJECT", "data": "Failed to persist intervention request."}

        start_time = time.time()
        # 2. 轮询数据库，等待决策
        while time.time() - start_time < timeout_seconds:
            try:
                # 从数据库获取最新的请求状态
                intervention_db_model = await db_get_intervention_request(req_id)
                if intervention_db_model and intervention_db_model.status != "pending":
                    logger.info(f"Agent {op_id}: 审批请求 '{req_id}' 已决策: {intervention_db_model.status}")
                    return {
                        "action": intervention_db_model.status.upper(), # approved/rejected/modified
                        "data": intervention_db_model.response_data
                    }
            except Exception as e:
                logger.warning(f"Agent {op_id}: 轮询数据库审批请求 '{req_id}' 失败: {e}")

            await asyncio.sleep(2) # 每2秒检查一次

        logger.warning(f"Agent {op_id}: 审批请求 '{req_id}' 超时，未收到决策。")
        # 超时默认拒绝
        return {"action": "REJECT", "data": "Intervention request timed out."}

    async def get_pending_request(self, op_id: str) -> Optional[Dict[str, Any]]:
        """
        Web UI调用此方法获取特定op_id下是否存在挂起的审批请求。
        """
        try:
            intervention_db_model = await get_pending_intervention_request(op_id)
            if intervention_db_model:
                return {
                    "id": intervention_db_model.id,
                    "op_id": intervention_db_model.session_id,
                    "type": intervention_db_model.type,
                    "data": intervention_db_model.request_data,
                    "created_at": intervention_db_model.created_at.timestamp()
                }
            return None
        except Exception as e:
            logger.error(f"Web {op_id}: 查询挂起审批请求失败: {e}")
            return None

    async def submit_decision(self, req_id: str, action: str, modified_data: Any = None) -> bool:
        """
        Web UI调用此方法提交决策。
        action: "APPROVE", "REJECT", "MODIFY"
        """
        # 将 action 映射到数据库状态
        db_status_map = {
            "APPROVE": "approved",
            "REJECT": "rejected",
            "MODIFY": "modified",
        }
        db_status = db_status_map.get(action.upper(), "pending") # Default to pending if unknown

        logger.info(f"Web: 提交决策 '{action}' for request '{req_id}', 状态: {db_status}")
        
        try:
            await update_intervention_response(req_id, db_status, response_data=modified_data)
            return True
        except Exception as e:
            logger.error(f"Web: 提交决策 '{req_id}' 到数据库失败: {e}")
            return False

# 全局单例
intervention_manager = InterventionManager()