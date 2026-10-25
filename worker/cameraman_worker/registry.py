"""Node-type registry loader (ADR-0006)."""

from __future__ import annotations

import json
import os
from pathlib import Path

from pydantic import BaseModel, Field


class Port(BaseModel):
    id: str
    type: str
    required: bool = True


class NodeType(BaseModel):
    id: str
    category: str
    title: str = ""
    inputs: list[Port] = Field(default_factory=list)
    outputs: list[Port] = Field(default_factory=list)
    config_schema: dict = Field(default_factory=dict)

    def input(self, port: str) -> Port | None:
        return next((p for p in self.inputs if p.id == port), None)

    def output(self, port: str) -> Port | None:
        return next((p for p in self.outputs if p.id == port), None)


class NodeRegistry:
    def __init__(self, types: dict[str, NodeType], version: int = 1):
        self.types = types
        self.version = version

    @classmethod
    def from_dict(cls, data: dict) -> NodeRegistry:
        types: dict[str, NodeType] = {}
        for raw in data["node_types"]:
            d = raw.get("descriptor", {})
            types[raw["id"]] = NodeType(
                id=raw["id"],
                category=raw.get("category", ""),
                title=raw.get("title", ""),
                inputs=d.get("inputs", []),
                outputs=d.get("outputs", []),
                config_schema=d.get("config", {}),
            )
        return cls(types, data.get("version", 1))

    @classmethod
    def load(cls, path: str | Path | None = None) -> NodeRegistry:
        path = path or os.environ.get("NODE_TYPES_PATH")
        if not path:
            raise FileNotFoundError("pass a path or set NODE_TYPES_PATH")
        return cls.from_dict(json.loads(Path(path).read_text()))

    def get(self, type_id: str) -> NodeType:
        return self.types[type_id]

    def __contains__(self, type_id: str) -> bool:
        return type_id in self.types
