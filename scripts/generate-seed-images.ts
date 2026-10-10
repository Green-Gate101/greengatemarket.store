import ZAI from 'z-ai-web-dev-sdk';
import fs from 'fs';
import path from 'path';

const products: Array<{ file: string; prompt: string }> = [
  { file: 'leather-laptop-sleeve', prompt: 'Professional product photography of a handcrafted brown leather laptop sleeve on a plain solid sage green background, studio lighting, centered, high quality' },
  { file: 'rooibos-tea-tin', prompt: 'Professional product photography of a decorative rooibos red tea tin container on a plain solid soft yellow background, studio lighting, centered, high quality' },
  { file: 'wireless-earbuds', prompt: 'Professional product photography of sleek black wireless earbuds with charging case on a plain solid coral pink background, studio lighting, centered, high quality' },
  { file: 'espresso-mug-set', prompt: 'Professional product photography of a set of two handmade ceramic espresso mugs, cream and terracotta colors, on a plain solid light mint background, studio lighting, centered, high quality' },
  { file: 'trail-backpack', prompt: 'Professional product photography of a durable olive green trail running backpack on a plain solid warm orange background, studio lighting, centered, high quality' },
  { file: 'beaded-bracelet', prompt: 'Professional product photography of a colorful beaded bracelet with geometric African patterns on a plain solid pale mint background, studio lighting, centered, high quality' },
  { file: 'soy-candle', prompt: 'Professional product photography of a scented soy candle in an amber glass jar on a plain solid soft lavender background, studio lighting, centered, high quality' },
  { file: 'honey-jar', prompt: 'Professional product photography of a glass jar of golden organic honey with wooden dipper on a plain solid light turquoise background, studio lighting, centered, high quality' },
  { file: 'canvas-tote', prompt: 'Professional product photography of a natural canvas tote bag with leather straps on a plain solid dusty rose background, studio lighting, centered, high quality' },
  { file: 'steel-bottle', prompt: 'Professional product photography of a matte forest green stainless steel water bottle on a plain solid warm beige background, studio lighting, centered, high quality' },
  { file: 'baobab-oil', prompt: 'Professional product photography of an amber glass dropper bottle of baobab facial oil on a plain solid light peach background, studio lighting, centered, high quality' },
  { file: 'wooden-bowl', prompt: 'Professional product photography of a hand carved wooden serving bowl on a plain solid slate gray background, studio lighting, centered, high quality' },
];

async function main() {
  const zai = await ZAI.create();
  const dir = path.join(process.cwd(), 'seed-images');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  for (const p of products) {
    const out = path.join(dir, `${p.file}.png`);
    if (fs.existsSync(out)) {
      console.log(`skip ${p.file}`);
      continue;
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await zai.images.generations.create({ prompt: p.prompt, size: '1024x1024' });
        const b64 = res.data[0]?.base64;
        if (!b64) throw new Error('empty response');
        fs.writeFileSync(out, Buffer.from(b64, 'base64'));
        console.log(`ok ${p.file}`);
        break;
      } catch (e) {
        console.error(`fail ${p.file} attempt ${attempt}: ${e instanceof Error ? e.message : e}`);
        if (attempt === 3) console.error(`giving up on ${p.file}`);
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }
  console.log('done');
}

main();
