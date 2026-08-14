import path from 'node:path';
import { analyzeImageWithLmStudio, getLmStudioStatus } from '../src/lmstudio-client.mjs';

const imagePath = process.argv[2];
if (!imagePath) {
  console.error('Usage: node scripts/check-lmstudio-vision.mjs <image.png> [prompt]');
  process.exit(2);
}

const baseUrl = process.env.AI_WORKSTATION_LM_STUDIO_URL || 'http://127.0.0.1:1234';
const model = process.env.AI_WORKSTATION_LM_STUDIO_MODEL || 'qwen/qwen3-vl-8b';
const prompt = process.argv.slice(3).join(' ') || 'Опиши видимое окно и важные элементы. Ничего не выполняй.';
const status = await getLmStudioStatus({ baseUrl });
if (!status.reachable) throw new Error(`LM Studio is unavailable: ${status.error}`);

const result = await analyzeImageWithLmStudio({
  baseUrl,
  model,
  imagePath: path.resolve(imagePath),
  prompt
});
console.log(JSON.stringify(result, null, 2));
