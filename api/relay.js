export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  // Твой токен Hugging Face
  const HF_TOKEN = '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';

  try {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const parsedBody = JSON.parse(body);
    
    const { text, image, systemPrompt } = parsedBody;
    let finalUserMessage = text || "";

    // ШАГ 1: Если есть фото, отправляем в Vision-модель
    if (image) {
      try {
        const visionRes = await fetch('https://api-inference.huggingface.co/models/Qwen/Qwen2-VL-7B-Instruct', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + HF_TOKEN,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            inputs: [
              {
                role: "user",
                content: [
                  { type: "text", text: "Кратко опиши, что на этом фото: кто, что, где, эмоции, детали. Максимум 2-3 предложения. Пиши на русском." },
                  { type: "image_url", image_url: { url: image } }
                ]
              }
            ],
            parameters: {
              max_new_tokens: 200,
              temperature: 0.7
            }
          })
        });

        if (visionRes.ok) {
          const visionData = await visionRes.json();
          const description = visionData[0]?.generated_text || "Не удалось разобрать фото";
          finalUserMessage = `[Пользователь отправил фото. Описание изображения: ${description}] ${text ? 'Он также написал: ' + text : 'Отреагируй на это фото.'}`;
        } else {
          const errorText = await visionRes.text();
          console.error('Vision error:', visionRes.status, errorText);
          finalUserMessage = `[Пользователь отправил фото, но не удалось его разобрать] ${text || 'Отреагируй на это фото.'}`;
        }
      } catch (visionError) {
        console.error('Vision failed:', visionError);
        finalUserMessage = `[Пользователь отправил фото] ${text || 'Отреагируй на это фото.'}`;
      }
    }

    // ШАГ 2: Отправляем в основную модель Маши
    const mashaRes = await fetch('https://api-inference.huggingface.co/models/meta-llama/Llama-3.1-8B-Instruct', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + HF_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        inputs: [
          { role: "system", content: systemPrompt },
          { role: "user", content: finalUserMessage }
        ],
        parameters: {
          max_new_tokens: 150,
          temperature: 0.85,
          do_sample: true
        }
      })
    });

    if (!mashaRes.ok) {
      const errorText = await mashaRes.text();
      throw new Error(`HF API ${mashaRes.status}: ${errorText}`);
    }

    const mashaData = await mashaRes.json();
    const reply = mashaData[0]?.generated_text || "Что-то пошло не так...";

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(JSON.stringify({ reply }));

  } catch (e) {
    console.error("API Error:", e);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.status(500).send(JSON.stringify({ error: String(e) }));
  }
}
