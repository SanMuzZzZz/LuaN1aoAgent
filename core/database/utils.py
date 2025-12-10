import os
import logging
import json
import asyncio
from datetime import datetime
from typing import Dict, Any, Optional

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy import select, update, delete
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from .models import Base, SessionModel, GraphNodeModel, GraphEdgeModel, EventLogModel, InterventionModel

# Default to a local SQLite database file
DB_PATH = os.getenv("DATABASE_PATH", "luan1ao.db")
DB_URL = f"sqlite+aiosqlite:///{DB_PATH}"

engine = create_async_engine(
    DB_URL,
    echo=False,
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    expire_on_commit=False,
    class_=AsyncSession
)

async def init_db():
    """Initialize the database by creating all tables."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

async def get_db_session() -> AsyncSession:
    """Dependency generator or context manager usage."""
    async with AsyncSessionLocal() as session:
        yield session

# --- CRUD Operations ---

async def create_session(session_id: str, name: str, goal: str, config: Dict[str, Any] = None):
    async with AsyncSessionLocal() as session:
        stmt = sqlite_insert(SessionModel).values(
            id=session_id,
            name=name,
            goal=goal,
            status="pending",
            config=config or {},
            created_at=datetime.now(),
            updated_at=datetime.now()
        )
        # Handle conflict (e.g. restart same session) - update goal/config
        stmt = stmt.on_conflict_do_update(
            index_elements=['id'],
            set_=dict(
                name=name,
                goal=goal,
                config=config or {},
                updated_at=datetime.now()
            )
        )
        await session.execute(stmt)
        await session.commit()

async def update_session_status(session_id: str, status: str):
    async with AsyncSessionLocal() as session:
        await session.execute(
            update(SessionModel)
            .where(SessionModel.id == session_id)
            .values(status=status, updated_at=datetime.now())
        )
        await session.commit()

async def upsert_node(session_id: str, node_id: str, graph_type: str, node_data: Dict[str, Any]):
    """Insert or update a graph node."""
    # Extract known fields for columns, put rest in data
    n_type = node_data.get("type") or node_data.get("node_type")
    status = node_data.get("status")
    
    # We need to serialize data properly. 
    # SQLAlchemy's JSON type handles dicts, but let's ensure it's clean.
    
    async with AsyncSessionLocal() as session:
        # Check if exists to determine insert or update (or use upsert logic)
        # SQLite upsert
        stmt = sqlite_insert(GraphNodeModel).values(
            session_id=session_id,
            node_id=node_id,
            graph_type=graph_type,
            type=n_type,
            status=status,
            data=node_data,
            updated_at=datetime.now()
        )
        
        # We need a unique constraint on (session_id, node_id, graph_type) for true upsert
        # But for now, let's just do a select-then-update/insert pattern which is safer across DBs if constraints aren't perfect
        # Actually, let's rely on simple select check for now to avoid complex migration of unique constraints
        
        result = await session.execute(
            select(GraphNodeModel).where(
                GraphNodeModel.session_id == session_id,
                GraphNodeModel.node_id == node_id,
                GraphNodeModel.graph_type == graph_type
            )
        )
        existing = result.scalar_one_or_none()
        
        if existing:
            existing.type = n_type
            existing.status = status
            existing.data = node_data
            existing.updated_at = datetime.now()
        else:
            session.add(GraphNodeModel(
                session_id=session_id,
                node_id=node_id,
                graph_type=graph_type,
                type=n_type,
                status=status,
                data=node_data
            ))
        
        # Touch session updated_at to trigger SSE
        await session.execute(
            update(SessionModel)
            .where(SessionModel.id == session_id)
            .values(updated_at=datetime.now())
        )
        
        await session.commit()

async def delete_node(session_id: str, node_id: str, graph_type: str):
    async with AsyncSessionLocal() as session:
        await session.execute(
            delete(GraphNodeModel).where(
                GraphNodeModel.session_id == session_id,
                GraphNodeModel.node_id == node_id,
                GraphNodeModel.graph_type == graph_type
            )
        )
        
        # Touch session updated_at to trigger SSE
        await session.execute(
            update(SessionModel)
            .where(SessionModel.id == session_id)
            .values(updated_at=datetime.now())
        )
        
        await session.commit()

async def add_edge(session_id: str, source: str, target: str, graph_type: str, edge_data: Dict[str, Any]):
    relation = edge_data.get("type") or edge_data.get("label") or "unknown"
    
    async with AsyncSessionLocal() as session:
        # Check existence to avoid duplicates if needed, or just insert (assuming multigraph or simple check)
        result = await session.execute(
            select(GraphEdgeModel).where(
                GraphEdgeModel.session_id == session_id,
                GraphEdgeModel.source_node_id == source,
                GraphEdgeModel.target_node_id == target,
                GraphEdgeModel.graph_type == graph_type,
                GraphEdgeModel.relation_type == relation
            )
        )
        if not result.scalar_one_or_none():
            session.add(GraphEdgeModel(
                session_id=session_id,
                source_node_id=source,
                target_node_id=target,
                graph_type=graph_type,
                relation_type=relation,
                data=edge_data
            ))
            
            # Touch session updated_at to trigger SSE
            await session.execute(
                update(SessionModel)
                .where(SessionModel.id == session_id)
                .values(updated_at=datetime.now())
            )
            
            await session.commit()

async def add_log(session_id: str, event_type: str, content: Dict[str, Any]):
    try:
        async with AsyncSessionLocal() as session:
            session.add(EventLogModel(
                session_id=session_id,
                event_type=event_type,
                content=content,
                timestamp=datetime.now() # Using datetime object, model will convert
            ))
            await session.commit()
    except Exception as e:
        print(f"Error adding log to DB: {e}")
        import traceback
        traceback.print_exc()

# --- Intervention CRUD Operations ---
async def create_intervention_request(req_id: str, session_id: str, req_type: str, request_data: Dict[str, Any]):
    async with AsyncSessionLocal() as session:
        intervention = InterventionModel(
            id=req_id,
            session_id=session_id,
            type=req_type,
            status="pending",
            request_data=request_data,
            created_at=datetime.now(),
            updated_at=datetime.now()
        )
        session.add(intervention)
        await session.commit()
        await session.refresh(intervention)
        return intervention

async def get_intervention_request(req_id: str) -> Optional[InterventionModel]:
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(InterventionModel).where(InterventionModel.id == req_id)
        )
        return result.scalar_one_or_none()

async def get_pending_intervention_request(session_id: str) -> Optional[InterventionModel]:
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(InterventionModel)
            .where(InterventionModel.session_id == session_id, InterventionModel.status == "pending")
            .order_by(InterventionModel.created_at.desc()) # Get the latest pending request
        )
        return result.scalar_one_or_none()

async def update_intervention_response(req_id: str, status: str, response_data: Dict[str, Any] = None):
    async with AsyncSessionLocal() as session:
        await session.execute(
            update(InterventionModel)
            .where(InterventionModel.id == req_id)
            .values(status=status, response_data=response_data, updated_at=datetime.now())
        )
        await session.commit()

# --- Helper for background tasks ---

def schedule_coroutine(coro):
    """Schedule a coroutine to run in the background threadsafe."""
    try:
        loop = asyncio.get_running_loop()
        task = loop.create_task(coro)
        def handle_result(t):
            try:
                t.result()
            except Exception as e:
                print(f"Background task failed: {e}")
                import traceback
                traceback.print_exc()
        task.add_done_callback(handle_result)
    except RuntimeError:
        # No running loop (shouldn't happen in Agent execution, but safe fallback)
        pass