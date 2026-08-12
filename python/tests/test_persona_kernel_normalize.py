import json

from antibrow.persona import generate_persona, load_or_generate_persona, read_persona


def _write(dir_path, persona_dict):
    (dir_path / "persona.json").write_text(json.dumps(persona_dict), encoding="utf-8")


def test_normalizes_legacy_full_version_without_rewriting(tmp_path):
    persona = generate_persona(150, "150").to_dict()
    persona["kernelVersion"] = "150.0.0.0"
    _write(tmp_path, persona)

    assert read_persona(tmp_path).kernel_version == "150"
    assert load_or_generate_persona(tmp_path, "150").kernel_version == "150"

    on_disk = json.loads((tmp_path / "persona.json").read_text(encoding="utf-8"))
    assert on_disk["kernelVersion"] == "150.0.0.0"


def test_new_profile_gets_a_major_only_version(tmp_path):
    persona = load_or_generate_persona(tmp_path, "151.0.0.0")
    assert persona.kernel_version == "151"
    assert persona.chrome_major == 151
    on_disk = json.loads((tmp_path / "persona.json").read_text(encoding="utf-8"))
    assert on_disk["kernelVersion"] == "151"
