from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from training.build_dataset import build_dataset


class BuildDatasetTests(unittest.TestCase):
    def test_step_frames_and_positive_feedback_become_samples(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            skills = root / "skills"
            teaching = root / "teaching"
            skills.mkdir()
            teaching.mkdir()
            before = root / "before.png"
            middle = root / "middle.png"
            after = root / "after.png"
            for image in (before, middle, after):
                image.write_bytes(b"test-image")
            skill = {
                "skillId": "skill-1",
                "instruction": "Draw a constrained shape",
                "application": {"processName": "DesignApp", "className": "DesignWindow"},
                "steps": [
                    {
                        "index": 0,
                        "type": "click",
                        "point": {"x": 0.1, "y": 0.2},
                        "visualEvidence": {"beforeImagePath": str(before), "afterImagePath": str(middle)},
                    },
                    {
                        "index": 1,
                        "type": "drag",
                        "from": {"x": 0.2, "y": 0.2},
                        "to": {"x": 0.5, "y": 0.5},
                        "modifiers": ["Control"],
                        "trajectoryMode": "adaptive",
                        "trajectory": [{"x": 0.2, "y": 0.2}, {"x": 0.5, "y": 0.5}],
                        "visualEvidence": {"beforeImagePath": str(middle), "afterImagePath": str(after)},
                    },
                ],
            }
            (skills / "skill-1.json").write_text(json.dumps(skill), encoding="utf-8")
            feedback = root / "episodes.jsonl"
            records = [
                {
                    "feedbackId": "positive-1",
                    "rating": "positive",
                    "instruction": "Select the tool",
                    "application": {"processName": "DesignApp", "className": "DesignWindow"},
                    "step": {
                        "action": {"type": "click", "point": {"x": 0.1, "y": 0.2}},
                        "visualEvidence": {"beforeImagePath": str(before), "afterImagePath": str(middle)},
                    },
                },
                {"feedbackId": "negative-1", "rating": "negative", "step": {"action": {"type": "click"}}},
            ]
            feedback.write_text("\n".join(json.dumps(item) for item in records) + "\n", encoding="utf-8")
            output = root / "dataset.jsonl"

            manifest = build_dataset(skills, teaching, feedback, output)
            samples = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]

            self.assertEqual(manifest["acceptedSamples"], 3)
            self.assertEqual(manifest["positiveFeedbackRecords"], 1)
            self.assertEqual(manifest["negativeFeedbackExcludedFromSft"], 1)
            self.assertEqual(samples[1]["messages"][-1]["content"][0]["text"].count("Control"), 1)
            self.assertEqual(samples[2]["source"], "human_approved_agent_step")


if __name__ == "__main__":
    unittest.main()
