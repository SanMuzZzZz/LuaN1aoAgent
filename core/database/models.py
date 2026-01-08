from datetime import datetime
from typing import Optional, Dict, Any
from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey, Boolean, JSON
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy.sql import func

class Base(DeclarativeBase):
    pass

class SessionModel(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String, primary_key=True)  # op_id
    name: Mapped[str] = mapped_column(String, nullable=True)   # task_name
    goal: Mapped[str] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String, default="pending")  # pending, running, completed, failed, stopped
    sort_index: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)  # For custom sorting
    
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())
    
    config: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSON, nullable=True)
    
    nodes: Mapped[list["GraphNodeModel"]] = relationship(back_populates="session", cascade="all, delete-orphan")
    edges: Mapped[list["GraphEdgeModel"]] = relationship(back_populates="session", cascade="all, delete-orphan")
    logs: Mapped[list["EventLogModel"]] = relationship(back_populates="session", cascade="all, delete-orphan")
    interventions: Mapped[list["InterventionModel"]] = relationship(back_populates="session", cascade="all, delete-orphan")


class GraphNodeModel(Base):
    __tablename__ = "graph_nodes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id"), index=True)
    
    node_id: Mapped[str] = mapped_column(String, index=True) # The ID used in NetworkX (e.g. "subtask_1")
    graph_type: Mapped[str] = mapped_column(String)  # 'task' or 'causal'
    
    type: Mapped[str] = mapped_column(String, nullable=True) # subtask, action, Evidence, etc.
    status: Mapped[str] = mapped_column(String, nullable=True)
    
    data: Mapped[Dict[str, Any]] = mapped_column(JSON, default={}) # Stores all node attributes
    
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())

    session: Mapped["SessionModel"] = relationship(back_populates="nodes")

class GraphEdgeModel(Base):
    __tablename__ = "graph_edges"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id"), index=True)
    
    source_node_id: Mapped[str] = mapped_column(String)
    target_node_id: Mapped[str] = mapped_column(String)
    
    graph_type: Mapped[str] = mapped_column(String) # 'task' or 'causal'
    relation_type: Mapped[str] = mapped_column(String, nullable=True) # dependency, caused_by...
    
    data: Mapped[Dict[str, Any]] = mapped_column(JSON, default={})
    
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    session: Mapped["SessionModel"] = relationship(back_populates="edges")

class EventLogModel(Base):
    __tablename__ = "event_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id"), index=True)
    
    event_type: Mapped[str] = mapped_column(String) # thought, tool_call, tool_result, status_change
    content: Mapped[Dict[str, Any]] = mapped_column(JSON)
    
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    session: Mapped["SessionModel"] = relationship(back_populates="logs")

class InterventionModel(Base):
    __tablename__ = "interventions"

    id: Mapped[str] = mapped_column(String, primary_key=True) # unique ID for the request
    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id"), index=True)
    
    type: Mapped[str] = mapped_column(String) # e.g., "plan_approval", "branch_replan_approval"
    status: Mapped[str] = mapped_column(String, default="pending") # pending, approved, rejected, modified
    
    request_data: Mapped[Dict[str, Any]] = mapped_column(JSON) # The data Agent requested approval for
    response_data: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSON, nullable=True) # User's decision
    
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())

    session: Mapped["SessionModel"] = relationship(back_populates="interventions")