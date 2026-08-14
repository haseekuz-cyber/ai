from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import torch
from datasets import Dataset
from peft import LoraConfig, prepare_model_for_kbit_training
from PIL import Image
from transformers import AutoProcessor, BitsAndBytesConfig, Qwen3VLForConditionalGeneration
from trl import SFTConfig, SFTTrainer


def load_records(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8-sig") as stream:
        for line_number, line in enumerate(stream, start=1):
            if not line.strip():
                continue
            record = json.loads(line)
            if not isinstance(record.get("images"), list) or len(record["images"]) != 2:
                raise ValueError(f"Line {line_number}: exactly two images are required.")
            record["images"] = [Image.open(image_path).convert("RGB") for image_path in record["images"]]
            records.append(record)
    return records


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train a versioned QLoRA adapter for the visual UI skill model.")
    parser.add_argument("--model", type=Path, default=Path(r"D:\AI-Work\Training\Models\Qwen3-VL-2B-Instruct"))
    parser.add_argument("--dataset", type=Path, default=Path(r"D:\AI-Work\Training\Datasets\ui-skills.jsonl"))
    parser.add_argument("--output-root", type=Path, default=Path(r"D:\AI-Work\Training\Adapters"))
    parser.add_argument("--max-steps", type=int, default=40)
    parser.add_argument("--min-samples", type=int, default=200)
    parser.add_argument("--allow-small-pilot", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not torch.cuda.is_available():
        raise SystemExit("CUDA is unavailable; training was not started.")
    records = load_records(args.dataset)
    required = 20 if args.allow_small_pilot else args.min_samples
    if len(records) < required:
        raise SystemExit(
            f"Training was not started: {len(records)} verified samples are available, {required} are required."
        )

    version = datetime.now(timezone.utc).strftime("ui-v%Y%m%d-%H%M%S")
    output = args.output_root / version
    output.mkdir(parents=True, exist_ok=False)

    quantization = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=torch.float16,
    )
    processor = AutoProcessor.from_pretrained(args.model, local_files_only=True)
    if hasattr(processor, "image_processor"):
        processor.image_processor.max_pixels = 1024 * 576
        processor.image_processor.min_pixels = 256 * 256
    model = Qwen3VLForConditionalGeneration.from_pretrained(
        args.model,
        local_files_only=True,
        quantization_config=quantization,
        device_map={"": 0},
        torch_dtype=torch.float16,
    )
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
    model.config.use_cache = False

    dataset = Dataset.from_list(records)
    lora = LoraConfig(
        r=16,
        lora_alpha=32,
        lora_dropout=0.05,
        bias="none",
        target_modules="all-linear",
        task_type="CAUSAL_LM",
    )
    training = SFTConfig(
        output_dir=str(output / "checkpoints"),
        max_length=None,
        max_steps=max(1, args.max_steps),
        per_device_train_batch_size=1,
        gradient_accumulation_steps=8,
        learning_rate=1e-4,
        warmup_ratio=0.05,
        logging_steps=1,
        save_steps=max(10, args.max_steps // 2),
        save_total_limit=2,
        fp16=True,
        bf16=False,
        gradient_checkpointing=True,
        remove_unused_columns=False,
        report_to="none",
        seed=42,
    )
    trainer = SFTTrainer(
        model=model,
        args=training,
        train_dataset=dataset,
        processing_class=processor,
        peft_config=lora,
    )
    trainer.train()
    trainer.save_model(str(output / "adapter"))
    processor.save_pretrained(str(output / "processor"))
    manifest = {
        "schemaVersion": 1,
        "adapterVersion": version,
        "baseModel": str(args.model.resolve()),
        "dataset": str(args.dataset.resolve()),
        "sampleCount": len(records),
        "maxSteps": args.max_steps,
        "pilot": args.allow_small_pilot,
        "promoted": False,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
