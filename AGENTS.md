# WithYou agent guidance

- Always use OpenAI Developer Docs MCP for OpenAI API work.
- Use Playwright MCP after the frontend runs.
- Never expose `OPENAI_API_KEY`.
- Never put secrets in frontend code.
- Do not implement diagnosis.
- Prioritize working functionality over styling.
- Keep raw wellness data local whenever possible.
- Use summarized `WellnessContext` objects for AI requests; never send full local history.
- Environmental sound sensing measures amplitude only and must never save recordings or infer conversations.
- Voice recordings are user-initiated, temporary, and must not be retained after processing.
- Do not add hardware-specific Arduino/ESP32 code until the exact board and sensors are known.

