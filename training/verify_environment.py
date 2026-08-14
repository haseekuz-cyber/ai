from __future__ import annotations

import json

import accelerate
import bitsandbytes
import datasets
import peft
import torch
import transformers
import trl
from transformers import BitsAndBytesConfig, Qwen3VLForConditionalGeneration


def main() -> None:
    if not torch.cuda.is_available():
        raise SystemExit("CUDA is unavailable in the training environment.")

    quantization = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=torch.float16,
    )
    probe = torch.randn((256, 256), device="cuda")
    result = probe @ probe
    report = {
        "ready": True,
        "pythonStack": {
            "torch": torch.__version__,
            "transformers": transformers.__version__,
            "datasets": datasets.__version__,
            "trl": trl.__version__,
            "peft": peft.__version__,
            "accelerate": accelerate.__version__,
            "bitsandbytes": bitsandbytes.__version__,
        },
        "gpu": {
            "name": torch.cuda.get_device_name(0),
            "vramGB": round(torch.cuda.get_device_properties(0).total_memory / 1024**3, 1),
            "cuda": torch.version.cuda,
            "calculationProbe": float(result[0, 0]),
        },
        "qlora": {
            "loadIn4Bit": quantization.load_in_4bit,
            "quantType": quantization.bnb_4bit_quant_type,
            "modelClass": Qwen3VLForConditionalGeneration.__name__,
        },
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
