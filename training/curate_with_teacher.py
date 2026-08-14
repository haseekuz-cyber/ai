from __future__ import annotations

import argparse
import base64
import io
import json
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from PIL import Image


TEACHER_SYSTEM_PROMPT = """You are the local senior teacher for a universal Windows visual UI agent.
You receive: a screenshot before a human demonstration, a screenshot after it, the human's task, and the exact recorded actions.
Review whether the final screenshot visibly supports the task and annotate the purpose of every recorded action.
Do not add, remove, reorder, or rewrite actions. Do not invent application-specific controls that are not visible.
Return JSON only in this exact shape:
{
  "accepted": true,
  "quality": 0.0,
  "goal": "short task goal",
  "successCriteria": "what must be visibly true at the end",
  "stepAnnotations": [
    {"index": 0, "purpose": "why this action is useful", "expectedResult": "visible local result", "trajectoryRole": "exact|adaptive|optional|replaceable"}
  ],
  "limitations": ["anything that cannot be verified from the two screenshots"]
}
Set accepted=false when the final result is visibly wrong, the recording is mostly accidental input, or the action sequence cannot be justified from the evidence."""

TEACHER_RESPONSE_SCHEMA = {
    "name": "ui_demonstration_review",
    "strict": True,
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["accepted", "quality", "goal", "successCriteria", "stepAnnotations", "limitations"],
        "properties": {
            "accepted": {"type": "boolean"},
            "quality": {"type": "number", "minimum": 0, "maximum": 1},
            "goal": {"type": "string"},
            "successCriteria": {"type": "string"},
            "stepAnnotations": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["index", "purpose", "expectedResult", "trajectoryRole"],
                    "properties": {
                        "index": {"type": "integer"},
                        "purpose": {"type": "string"},
                        "expectedResult": {"type": "string"},
                        "trajectoryRole": {
                            "type": "string",
                            "enum": ["exact", "adaptive", "optional", "replaceable"],
                        },
                    },
                },
            },
            "limitations": {"type": "array", "items": {"type": "string"}},
        },
    },
}


def read_records(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8-sig") as stream:
        for line in stream:
            if line.strip():
                value = json.loads(line)
                if isinstance(value, dict):
                    records.append(value)
    return records


def image_data_url(path: str, max_edge: int = 1600) -> str:
    file_path = Path(path)
    with Image.open(file_path) as image:
        image = image.convert("RGB")
        if max(image.size) > max_edge:
            scale = max_edge / max(image.size)
            image = image.resize(
                (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
                Image.Resampling.LANCZOS,
            )
        output = io.BytesIO()
        image.save(output, format="JPEG", quality=90, optimize=True)
    encoded = base64.b64encode(output.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


def text_content(message: dict[str, Any]) -> str:
    content = message.get("content")
    if not isinstance(content, list):
        return ""
    return "\n".join(str(item.get("text") or "") for item in content if isinstance(item, dict) and item.get("type") == "text")


def parse_json_object(raw: str) -> dict[str, Any]:
    source = raw.strip()
    fenced = re.fullmatch(r"```(?:json)?\s*([\s\S]*?)\s*```", source, re.IGNORECASE)
    if fenced:
        source = fenced.group(1)
    value = json.loads(source)
    if not isinstance(value, dict):
        raise ValueError("Teacher response must be a JSON object.")
    return value


def review_record(record: dict[str, Any], endpoint: str, model: str, timeout: int) -> dict[str, Any]:
    images = record.get("images")
    messages = record.get("messages")
    if not isinstance(images, list) or len(images) != 2 or not isinstance(messages, list) or len(messages) < 3:
        raise ValueError("Candidate must contain two images and three messages.")
    raw_skill = json.loads(text_content(messages[-1]))
    actions = raw_skill.get("steps")
    if not isinstance(actions, list) or not actions:
        raise ValueError("Candidate has no recorded actions.")
    prompt = {
        "task": raw_skill.get("goal"),
        "applicationClass": raw_skill.get("applicationClass"),
        "recordedActions": actions,
        "instruction": "Review the demonstration using the before and after screenshots. Annotate exactly these actions.",
    }
    payload = {
        "model": model,
        "temperature": 0.1,
        "max_tokens": 3000,
        "response_format": {"type": "json_schema", "json_schema": TEACHER_RESPONSE_SCHEMA},
        "messages": [
            {"role": "system", "content": TEACHER_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": json.dumps(prompt, ensure_ascii=False, separators=(",", ":"))},
                    {"type": "image_url", "image_url": {"url": image_data_url(images[0])}},
                    {"type": "image_url", "image_url": {"url": image_data_url(images[1])}},
                ],
            },
        ],
    }
    request = urllib.request.Request(
        endpoint.rstrip("/") + "/v1/chat/completions",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.load(response)
    except urllib.error.HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Teacher HTTP {error.code}: {details[:500]}") from error
    raw = body["choices"][0]["message"]["content"]
    review = parse_json_object(raw)
    annotations = review.get("stepAnnotations")
    expected_indices = [int(step.get("index", index)) for index, step in enumerate(actions)]
    actual_indices = [int(item.get("index")) for item in annotations] if isinstance(annotations, list) else []
    if actual_indices != expected_indices:
        raise ValueError("Teacher annotations do not match the exact recorded action indices.")
    quality = min(max(float(review.get("quality") or 0), 0), 1)
    accepted = review.get("accepted") is True and quality >= 0.7
    return {**review, "accepted": accepted, "quality": quality, "rawSkill": raw_skill}


def merge_review(record: dict[str, Any], review: dict[str, Any], model: str) -> dict[str, Any]:
    raw_skill = review["rawSkill"]
    annotations = review["stepAnnotations"]
    steps: list[dict[str, Any]] = []
    for action, annotation in zip(raw_skill["steps"], annotations, strict=True):
        role = str(annotation.get("trajectoryRole") or "optional")
        if role not in {"exact", "adaptive", "optional", "replaceable"}:
            role = "optional"
        steps.append(
            {
                **action,
                "purpose": str(annotation.get("purpose") or "")[:500],
                "expectedResult": str(annotation.get("expectedResult") or action.get("expectedResult") or "")[:500],
                "trajectoryRole": role,
            }
        )
    answer = {
        "goal": str(review.get("goal") or raw_skill.get("goal") or "")[:1000],
        "applicationClass": raw_skill.get("applicationClass") or "",
        "successCriteria": str(review.get("successCriteria") or "")[:1000],
        "steps": steps,
    }
    result = {**record}
    result["messages"] = [*record["messages"][:-1], {
        "role": "assistant",
        "content": [{"type": "text", "text": json.dumps(answer, ensure_ascii=False, separators=(",", ":"))}],
    }]
    result["metadata"] = {
        **record.get("metadata", {}),
        "teacherModel": model,
        "teacherAccepted": True,
        "teacherQuality": review["quality"],
        "teacherLimitations": [str(item)[:500] for item in review.get("limitations", []) if isinstance(item, str)][:20],
    }
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Curate human demonstrations with a local vision teacher.")
    parser.add_argument("--input", type=Path, default=Path(r"D:\AI-Work\Training\Datasets\ui-skill-candidates.jsonl"))
    parser.add_argument("--output", type=Path, default=Path(r"D:\AI-Work\Training\Datasets\ui-skills.jsonl"))
    parser.add_argument("--endpoint", default="http://127.0.0.1:1234")
    parser.add_argument("--model", default="qwen/qwen3-vl-8b")
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--limit", type=int, default=0)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    records = read_records(args.input)
    if args.limit > 0:
        records = records[: args.limit]
    accepted: list[dict[str, Any]] = []
    decisions: list[dict[str, Any]] = []
    for record in records:
        sample_id = str(record.get("sampleId") or "unknown")
        try:
            review = review_record(record, args.endpoint, args.model, args.timeout)
            decisions.append({
                "sampleId": sample_id,
                "accepted": review["accepted"],
                "quality": review["quality"],
                "limitations": review.get("limitations", []),
            })
            if review["accepted"]:
                accepted.append(merge_review(record, review, args.model))
        except (OSError, ValueError, KeyError, TypeError, RuntimeError, json.JSONDecodeError) as error:
            decisions.append({"sampleId": sample_id, "accepted": False, "error": str(error)[:500]})

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8", newline="\n") as stream:
        for record in accepted:
            stream.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    manifest = {
        "schemaVersion": 1,
        "teacherModel": args.model,
        "candidateCount": len(records),
        "acceptedCount": len(accepted),
        "rejectedCount": len(records) - len(accepted),
        "trainingReady": len(accepted) >= 20,
        "decisions": decisions,
    }
    args.output.with_suffix(".manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
