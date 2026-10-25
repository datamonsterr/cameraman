import copy

from conftest import make_graph

from cameraman_worker.graph import validate_graph


def codes(registry, g):
    return {e.code for e in validate_graph(g, registry).errors}


def test_registry_loads_types(registry):
    assert {"camera", "codeblock", "email"} <= set(registry.types)
    assert registry.get("camera").outputs[0].type == "frame"


def test_valid_graph(registry):
    r = validate_graph(make_graph("pass"), registry)
    assert r.ok, r.errors
    assert r.order == ["cam", "code", "mail"]


def test_unknown_node_type(registry):
    g = make_graph("pass")
    g["nodes"][1]["type"] = "nope"
    assert "unknown_type" in codes(registry, g)


def test_missing_required_config(registry):
    g = make_graph("pass")
    del g["nodes"][1]["config"]["code"]
    assert "missing_config" in codes(registry, g)
    g = make_graph("pass", email_cfg={"subject": "x"})
    assert "missing_config" in codes(registry, g)


def test_wrong_config_type(registry):
    g = make_graph("pass")
    g["nodes"][0]["config"]["fps"] = "fast"
    assert "bad_config" in codes(registry, g)
    g = make_graph("pass")
    g["nodes"][0]["config"]["fps"] = 99
    assert "bad_config" in codes(registry, g)


def test_dangling_required_input(registry):
    g = make_graph("pass")
    g["edges"] = g["edges"][:1]  # email has no trigger
    assert "dangling_input" in codes(registry, g)
    g = make_graph("pass")
    g["edges"] = g["edges"][1:]  # codeblock has no frames
    assert "dangling_input" in codes(registry, g)


def test_edge_references_unknown_node_or_port(registry):
    g = make_graph("pass")
    g["edges"][0]["target"] = "ghost"
    assert "bad_edge" in codes(registry, g)
    g = make_graph("pass")
    g["edges"][0]["sourceHandle"] = "zzz"
    assert "bad_edge" in codes(registry, g)


def test_port_type_mismatch(registry):
    g = make_graph("pass")
    g["edges"][1]["sourceHandle"] = "result"  # object -> action input
    assert "type_mismatch" in codes(registry, g)


def test_cycle_detected(registry):
    g = make_graph("pass")
    g["edges"].append(
        {
            "id": "e3",
            "source": "code",
            "sourceHandle": "actions",
            "target": "code",
            "targetHandle": "frames",
        }
    )
    assert "cycle" in codes(registry, g) or "type_mismatch" in codes(registry, g)
    g = copy.deepcopy(make_graph("pass"))
    g["edges"].append(
        {
            "id": "e4",
            "source": "code",
            "sourceHandle": "result",
            "target": "code",
            "targetHandle": "frames",
        }
    )
    assert "cycle" in codes(registry, g)


def test_duplicate_node_ids(registry):
    g = make_graph("pass")
    g["nodes"][2]["id"] = "code"
    assert "duplicate_id" in codes(registry, g)


def test_wiring_requires_camera_source(registry):
    g = make_graph("pass")
    g["nodes"] = [n for n in g["nodes"] if n["id"] != "cam"]
    g["edges"] = g["edges"][1:]
    assert "dangling_input" in codes(registry, g)


def test_seed_workflows_validate(registry):
    import json
    from pathlib import Path

    seed = Path(__file__).parents[2] / "db/seed/workflows"
    files = list(seed.glob("*.json")) if seed.exists() else []
    for f in files:
        assert validate_graph(json.loads(f.read_text())["graph"], registry).ok, f.name
