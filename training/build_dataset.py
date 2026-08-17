from __future__ import annotations

import argparse
import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


SYSTEM_PROMPT = """You are a compact visual Windows UI skill model.
The first image is the state before a successful human demonstration and the second image is its verified final reference.
Return the demonstrated reusable skill as JSON. Preserve action order, explicit keyboard modifiers, and meaningful drag trajectories.
Coordinates are normalized to the target window. Do not invent controls or actions that are absent from the demonstration."""

STEP_SYSTEM_PROMPT = """You are a compact visual Windows UI action model.
The first image is the exact state before one human-approved UI action and the second image is the observed state after it.
Return exactly that reusable action as JSON. Preserve explicit keyboard modifiers and meaningful drag trajectories.
Coordinates are normalized to the target window. Do not invent controls, actions, or success evidence."""

SAFE_LITERAL_TEXT = re.compile(r"^[\d\s.,:+%°xX×/\\-]{1,32}(?:\s*(?:cm|mm|px|pt|см|мм))?$", re.IGNORECASE)
ALLOWED_ACTION_FIELDS = {
    "index",
    "type",
    "target",
    "point",
    "from",
    "to",
    "button",
    "delta",
    "durationMs",
    "key",
    "modifiers",
    "trajectoryMode",
    "trajectory",
    "expectedResult",
}


@dataclass(frozen=True)
class TeachingCapture:
    session_id: str
    before_path: Path
    after_path: Path
    after_sha256: str


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest().upper()


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8-sig") as stream:
        value = json.load(stream)
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object: {path}")
    return value


def teaching_captures(root: Path) -> dict[str, TeachingCapture]:
    captures: dict[str, TeachingCapture] = {}
    if not root.exists():
        return captures
    for folder in root.iterdir():
        before = folder / "before.png"
        after = folder / "after.png"
        if not folder.is_dir() or not before.is_file() or not after.is_file():
            continue
        checksum = sha256_file(after)
        captures[checksum] = TeachingCapture(folder.name, before.resolve(), after.resolve(), checksum)
    return captures


def redact_text(value: Any) -> str:
    text = str(value or "")
    return text if SAFE_LITERAL_TEXT.fullmatch(text.strip()) else "<USER_TEXT>"


def compact_trajectory(points: Any, limit: int = 64) -> list[dict[str, float]]:
    if not isinstance(points, list):
        return []
    valid = [point for point in points if isinstance(point, dict) and "x" in point and "y" in point]
    if len(valid) <= limit:
        return [{"x": float(point["x"]), "y": float(point["y"])} for point in valid]
    indices = sorted({round(index * (len(valid) - 1) / (limit - 1)) for index in range(limit)})
    return [{"x": float(valid[index]["x"]), "y": float(valid[index]["y"])} for index in indices]


def sanitize_step(step: Any) -> dict[str, Any] | None:
    if not isinstance(step, dict) or step.get("type") not in {
        "click",
        "doubleClick",
        "drag",
        "scroll",
        "typeText",
        "pressKey",
    }:
        return None
    target = step.get("target") if isinstance(step.get("target"), dict) else {}
    if step.get("isPassword") is True or target.get("isPassword") is True:
        return None
    clean = {key: step[key] for key in ALLOWED_ACTION_FIELDS if key in step}
    if clean.get("type") == "typeText":
        clean["text"] = redact_text(step.get("text"))
    if "trajectory" in clean:
        clean["trajectory"] = compact_trajectory(clean["trajectory"])
    clean.pop("atMs", None)
    return clean


def eligible_sample(skill: dict[str, Any], capture: TeachingCapture, max_steps: int) -> dict[str, Any] | None:
    instruction = str(skill.get("instruction") or skill.get("name") or "").strip()
    raw_steps = skill.get("steps")
    if not instruction or not isinstance(raw_steps, list) or not (1 <= len(raw_steps) <= max_steps):
        return None
    steps = [clean for raw in raw_steps if (clean := sanitize_step(raw)) is not None]
    if not steps or len(steps) != len(raw_steps):
        return None
    application = skill.get("application") if isinstance(skill.get("application"), dict) else {}
    answer = {
        "goal": instruction,
        "applicationClass": application.get("className") or "",
        "successReference": "second_image",
        "steps": steps,
    }
    user_text = (
        f"Task: {instruction}\n"
        "Compile the successful demonstration into one reusable UI skill. "
        "The before and final-reference screenshots are supplied in that order."
    )
    return {
        "sampleId": str(skill.get("skillId") or capture.session_id),
        "source": "human_demonstration_with_visual_reference",
        "images": [str(capture.before_path), str(capture.after_path)],
        "messages": [
            {"role": "system", "content": [{"type": "text", "text": SYSTEM_PROMPT}]},
            {
                "role": "user",
                "content": [
                    {"type": "image"},
                    {"type": "image"},
                    {"type": "text", "text": user_text},
                ],
            },
            {
                "role": "assistant",
                "content": [{"type": "text", "text": json.dumps(answer, ensure_ascii=False, separators=(",", ":"))}],
            },
        ],
        "metadata": {
            "teachingSessionId": capture.session_id,
            "createdAt": skill.get("createdAt"),
            "processName": application.get("processName"),
            "stepCount": len(steps),
            "humanDemonstrated": True,
            "visualReferenceVerified": True,
        },
    }


def step_sample(
    *,
    sample_id: str,
    instruction: str,
    application: dict[str, Any],
    raw_step: dict[str, Any],
    before_path: Path,
    after_path: Path,
    source: str,
    metadata: dict[str, Any],
) -> dict[str, Any] | None:
    if not instruction or not before_path.is_file() or not after_path.is_file():
        return None
    step = sanitize_step(raw_step)
    if step is None:
        return None
    answer = {
        "goal": instruction,
        "applicationClass": application.get("className") or "",
        "successReference": "second_image",
        "steps": [step],
    }
    return {
        "sampleId": sample_id,
        "source": source,
        "images": [str(before_path.resolve()), str(after_path.resolve())],
        "messages": [
            {"role": "system", "content": [{"type": "text", "text": STEP_SYSTEM_PROMPT}]},
            {
                "role": "user",
                "content": [
                    {"type": "image"},
                    {"type": "image"},
                    {"type": "text", "text": f"Task: {instruction}\nExplain and reproduce only the demonstrated successful action."},
                ],
            },
            {
                "role": "assistant",
                "content": [{"type": "text", "text": json.dumps(answer, ensure_ascii=False, separators=(",", ":"))}],
            },
        ],
        "metadata": {
            **metadata,
            "processName": application.get("processName"),
            "stepCount": 1,
            "visualEvidenceCaptured": True,
        },
    }


def skill_step_samples(skill: dict[str, Any]) -> tuple[list[dict[str, Any]], int]:
    instruction = str(skill.get("instruction") or skill.get("name") or "").strip()
    application = skill.get("application") if isinstance(skill.get("application"), dict) else {}
    samples: list[dict[str, Any]] = []
    missing = 0
    for index, raw_step in enumerate(skill.get("steps") or []):
        evidence = raw_step.get("visualEvidence") if isinstance(raw_step, dict) and isinstance(raw_step.get("visualEvidence"), dict) else {}
        before = Path(str(evidence.get("beforeImagePath") or ""))
        after = Path(str(evidence.get("afterImagePath") or ""))
        sample = step_sample(
            sample_id=f"{skill.get('skillId') or 'skill'}-step-{index}",
            instruction=instruction,
            application=application,
            raw_step=raw_step,
            before_path=before,
            after_path=after,
            source="human_demonstration_step_with_visual_evidence",
            metadata={
                "skillId": skill.get("skillId"),
                "stepIndex": index,
                "createdAt": skill.get("createdAt"),
                "humanDemonstrated": True,
            },
        )
        if sample is None:
            missing += 1
        else:
            samples.append(sample)
    return samples, missing


def iter_feedback_records(path: Path) -> Iterable[dict[str, Any]]:
    if not path.is_file():
        return []
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8-sig") as stream:
        for line in stream:
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                records.append(value)
    return records


def feedback_training_approved(record: dict[str, Any]) -> bool:
    experience = record.get("experience")
    if isinstance(experience, dict):
        return experience.get("state") == "training_approved"
    step = record.get("step") if isinstance(record.get("step"), dict) else {}
    validation = step.get("automatedValidation") if isinstance(step.get("automatedValidation"), dict) else {}
    return record.get("rating") == "positive" and step.get("humanApproved") is True and validation.get("success") is True


def feedback_sample(record: dict[str, Any]) -> dict[str, Any] | None:
    if not feedback_training_approved(record) or not isinstance(record.get("step"), dict):
        return None
    step = record["step"]
    evidence = step.get("visualEvidence") if isinstance(step.get("visualEvidence"), dict) else {}
    application = record.get("application") if isinstance(record.get("application"), dict) else {}
    return step_sample(
        sample_id=str(record.get("feedbackId") or "feedback"),
        instruction=str(record.get("instruction") or "").strip(),
        application=application,
        raw_step=step.get("action") if isinstance(step.get("action"), dict) else {},
        before_path=Path(str(evidence.get("beforeImagePath") or "")),
        after_path=Path(str(evidence.get("afterImagePath") or "")),
        source="human_approved_agent_step",
        metadata={
            "feedbackId": record.get("feedbackId"),
            "planId": record.get("planId"),
            "runId": record.get("runId"),
            "skillId": record.get("skillId"),
            "stepIndex": record.get("stepIndex"),
            "createdAt": record.get("createdAt"),
            "humanApproved": True,
            "experienceState": (record.get("experience") or {}).get("state", "legacy_verified"),
        },
    )


def iter_skill_files(root: Path) -> Iterable[Path]:
    return sorted(path for path in root.glob("*.json") if path.is_file())


def build_dataset(
    skills_root: Path,
    teaching_root: Path,
    feedback_path: Path,
    output: Path,
    max_steps: int = 64,
) -> dict[str, Any]:
    captures = teaching_captures(teaching_root)
    samples: list[dict[str, Any]] = []
    rejected: list[dict[str, str]] = []
    for skill_path in iter_skill_files(skills_root):
        try:
            skill = read_json(skill_path)
            step_samples, missing_step_frames = skill_step_samples(skill)
            if step_samples:
                samples.extend(step_samples)
                if missing_step_frames:
                    rejected.append({"file": skill_path.name, "reason": f"{missing_step_frames}_steps_missing_visual_evidence"})
                continue
            reference = skill.get("visualReference") if isinstance(skill.get("visualReference"), dict) else {}
            checksum = str(reference.get("sha256") or "").upper()
            capture = captures.get(checksum)
            if capture is None:
                rejected.append({"file": skill_path.name, "reason": "no_matching_before_and_after_capture"})
                continue
            sample = eligible_sample(skill, capture, max_steps)
            if sample is None:
                rejected.append({"file": skill_path.name, "reason": "failed_quality_gate"})
                continue
            samples.append(sample)
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
            rejected.append({"file": skill_path.name, "reason": str(error)[:200]})

    positive_feedback = 0
    negative_feedback = 0
    for record in iter_feedback_records(feedback_path):
        if record.get("rating") == "negative":
            negative_feedback += 1
            continue
        if record.get("rating") != "positive":
            continue
        positive_feedback += 1
        sample = feedback_sample(record)
        if sample is None:
            rejected.append({"file": str(record.get("feedbackId") or "feedback"), "reason": "positive_feedback_not_training_approved_or_missing_visual_evidence"})
        else:
            samples.append(sample)

    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8", newline="\n") as stream:
        for sample in samples:
            stream.write(json.dumps(sample, ensure_ascii=False, separators=(",", ":")) + "\n")
    manifest = {
        "schemaVersion": 2,
        "dataset": str(output.resolve()),
        "acceptedSamples": len(samples),
        "rejectedSamples": len(rejected),
        "trainingReady": len(samples) >= 20,
        "minimumRecommendedSamples": 200,
        "smallPilotMinimumSamples": 20,
        "positiveFeedbackRecords": positive_feedback,
        "negativeFeedbackExcludedFromSft": negative_feedback,
        "rejected": rejected,
    }
    manifest_path = output.with_suffix(".manifest.json")
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a local VLM dataset from verified UI demonstrations.")
    parser.add_argument("--skills", type=Path, default=Path(r"D:\AI-Work\Agent-Data\Skills"))
    parser.add_argument("--teaching", type=Path, default=Path(r"D:\AI-Work\Agent-Data\Teaching"))
    parser.add_argument("--feedback", type=Path, default=Path(r"D:\AI-Work\Agent-Data\Learning\episodes.jsonl"))
    parser.add_argument("--output", type=Path, default=Path(r"D:\AI-Work\Training\Datasets\ui-skill-candidates.jsonl"))
    parser.add_argument("--max-steps", type=int, default=64)
    return parser.parse_args()


if __name__ == "__main__":
    arguments = parse_args()
    print(
        json.dumps(
            build_dataset(arguments.skills, arguments.teaching, arguments.feedback, arguments.output, arguments.max_steps),
            ensure_ascii=False,
            indent=2,
        )
    )
