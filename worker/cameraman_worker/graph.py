"""Workflow graph model + validation against the node registry (FR-8)."""

from __future__ import annotations

from dataclasses import dataclass, field

from pydantic import BaseModel, ConfigDict, Field

from .registry import NodeRegistry


class Node(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    type: str
    config: dict = Field(default_factory=dict)


class Edge(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)
    id: str = ""
    source: str
    target: str
    source_handle: str = Field(alias="sourceHandle")
    target_handle: str = Field(alias="targetHandle")


class Graph(BaseModel):
    model_config = ConfigDict(extra="ignore")
    nodes: list[Node] = Field(default_factory=list)
    edges: list[Edge] = Field(default_factory=list)

    def node(self, node_id: str) -> Node:
        return next(n for n in self.nodes if n.id == node_id)


@dataclass(frozen=True)
class ValidationError:
    code: str
    message: str
    node_id: str | None = None


@dataclass
class ValidationResult:
    errors: list[ValidationError] = field(default_factory=list)
    order: list[str] = field(default_factory=list)
    graph: Graph | None = None

    @property
    def ok(self) -> bool:
        return not self.errors


_TYPES = {
    "string": str,
    "integer": int,
    "number": (int, float),
    "boolean": bool,
    "array": list,
    "object": dict,
}


def _type_ok(value, t: str) -> bool:
    if t in ("integer", "number") and isinstance(value, bool):
        return False
    return isinstance(value, _TYPES.get(t, object))


def _check_config(node: Node, schema: dict, errs: list[ValidationError]) -> None:
    for key in schema.get("required", []):
        if key not in node.config or node.config[key] in (None, ""):
            errs.append(
                ValidationError("missing_config", f"missing required config '{key}'", node.id)
            )
    for key, spec in schema.get("properties", {}).items():
        if key not in node.config:
            continue
        v = node.config[key]
        t = spec.get("type")
        if t and not _type_ok(v, t):
            errs.append(ValidationError("bad_config", f"'{key}' must be {t}", node.id))
            continue
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            if "minimum" in spec and v < spec["minimum"]:
                errs.append(ValidationError("bad_config", f"'{key}' below minimum", node.id))
            if "maximum" in spec and v > spec["maximum"]:
                errs.append(ValidationError("bad_config", f"'{key}' above maximum", node.id))
        it = spec.get("items", {}).get("type")
        if t == "array" and it and not all(_type_ok(x, it) for x in v):
            errs.append(ValidationError("bad_config", f"'{key}' items must be {it}", node.id))


def validate_graph(raw: dict | Graph, registry: NodeRegistry) -> ValidationResult:
    res = ValidationResult()
    errs = res.errors
    try:
        g = raw if isinstance(raw, Graph) else Graph.model_validate(raw)
    except Exception as e:  # pydantic validation of shape
        errs.append(ValidationError("malformed", str(e)))
        return res
    res.graph = g

    ids: dict[str, Node] = {}
    for n in g.nodes:
        if n.id in ids:
            errs.append(ValidationError("duplicate_id", f"duplicate node id '{n.id}'", n.id))
        ids[n.id] = n
        if n.type not in registry:
            errs.append(ValidationError("unknown_type", f"unknown node type '{n.type}'", n.id))
        else:
            _check_config(n, registry.get(n.type).config_schema, errs)

    connected: set[tuple[str, str]] = set()
    for e in g.edges:
        src, dst = ids.get(e.source), ids.get(e.target)
        if src is None or dst is None:
            errs.append(ValidationError("bad_edge", f"edge '{e.id}' references unknown node"))
            continue
        if src.type not in registry or dst.type not in registry:
            continue
        sp = registry.get(src.type).output(e.source_handle)
        dp = registry.get(dst.type).input(e.target_handle)
        if sp is None or dp is None:
            errs.append(ValidationError("bad_edge", f"edge '{e.id}' uses unknown port"))
            continue
        connected.add((dst.id, dp.id))
        if sp.type != dp.type:
            errs.append(
                ValidationError("type_mismatch", f"edge '{e.id}': {sp.type} -> {dp.type}", dst.id)
            )

    for n in g.nodes:
        if n.type not in registry:
            continue
        for p in registry.get(n.type).inputs:
            if p.required and (n.id, p.id) not in connected:
                errs.append(
                    ValidationError("dangling_input", f"required input '{p.id}' not wired", n.id)
                )

    order = _toposort(g, ids)
    if order is None:
        errs.append(ValidationError("cycle", "graph contains a cycle"))
    else:
        res.order = order
    return res


def _toposort(g: Graph, ids: dict[str, Node]) -> list[str] | None:
    indeg = {i: 0 for i in ids}
    out: dict[str, list[str]] = {i: [] for i in ids}
    for e in g.edges:
        if e.source in ids and e.target in ids:
            out[e.source].append(e.target)
            indeg[e.target] += 1
    ready = [n.id for n in g.nodes if indeg[n.id] == 0 and n.id in ids]
    order: list[str] = []
    while ready:
        cur = ready.pop(0)
        order.append(cur)
        for nxt in out[cur]:
            indeg[nxt] -= 1
            if indeg[nxt] == 0:
                ready.append(nxt)
    return order if len(order) == len(ids) else None
