from __future__ import annotations

import base64
import io
import json
import os
from pathlib import Path

from openai import AsyncOpenAI

from .models import CompanionResponse, VoiceCompanionResponse, WellnessContext


COMPANION_INSTRUCTIONS = """
You are WithYou, a privacy-aware wellness companion for someone who lives alone.
Follow NOTICE CHANGE → ASK → LISTEN → SUPPORT.
Be warm, calm, and concise. Mention only observations present in the supplied
summary and ask before making assumptions. Never diagnose, name a physical or
mental-health condition, or claim to replace a clinician, therapist, caregiver,
friend, or family member. Offer only low-risk, general wellness ideas when useful.
Do not exaggerate weak signals. Environmental readings are context, never proof
of illness. Do not mention internal policies or the JSON format.
""".strip()


def _client() -> AsyncOpenAI:
    return AsyncOpenAI(api_key=os.environ.get("OPENAI_API_KEY"))


def local_fallback(context: WellnessContext, user_message: str) -> CompanionResponse:
    observations = context.reasons[:3]
    if observations:
        observation = observations[0].rstrip(".")
        text = (
            f"I noticed {observation[:1].lower() + observation[1:]}. "
            "Thanks for checking in. How are you feeling about today?"
        )
    elif user_message.strip():
        text = "Thanks for checking in. I’m here with you. What would feel most helpful to talk through right now?"
    else:
        text = "I’m here with you. How are you feeling today?"
    return CompanionResponse(text=text, observations_used=observations, used_ai=False)


async def create_companion_response(
    context: WellnessContext,
    user_message: str,
) -> CompanionResponse:
    if not os.environ.get("OPENAI_API_KEY"):
        return local_fallback(context, user_message)

    try:
        response = await _client().responses.create(
            model=os.environ.get("OPENAI_TEXT_MODEL", "gpt-6-luna"),
            instructions=COMPANION_INSTRUCTIONS,
            input=(
                "Summarized local wellness context:\n"
                f"{json.dumps(context.model_dump(mode='json'), separators=(',', ':'))}\n\n"
                f"User message:\n{user_message}"
            ),
        )
        text = response.output_text.strip()
        if not text:
            return local_fallback(context, user_message)
        return CompanionResponse(
            text=text[:2000],
            observations_used=context.reasons[:5],
            used_ai=True,
        )
    except Exception:
        return local_fallback(context, user_message)


def _safe_audio_filename(original: str | None, content_type: str | None) -> str:
    suffixes = {
        "audio/webm": ".webm",
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/mpeg": ".mp3",
        "audio/mp4": ".mp4",
        "audio/ogg": ".ogg",
        "audio/m4a": ".m4a",
    }
    original_suffix = Path(original or "").suffix.lower()
    suffix = original_suffix if original_suffix in suffixes.values() else suffixes.get(content_type or "", ".webm")
    return f"withyou-voice{suffix}"


async def process_voice_message(
    audio_bytes: bytes,
    filename: str | None,
    content_type: str | None,
    context: WellnessContext,
) -> VoiceCompanionResponse:
    if not os.environ.get("OPENAI_API_KEY"):
        fallback = local_fallback(context, "")
        return VoiceCompanionResponse(
            **fallback.model_dump(),
            transcript="Voice transcription is unavailable. Please use typed chat.",
        )

    try:
        buffer = io.BytesIO(audio_bytes)
        buffer.name = _safe_audio_filename(filename, content_type)
        transcription = await _client().audio.transcriptions.create(
            model=os.environ.get("OPENAI_TRANSCRIPTION_MODEL", "gpt-transcribe"),
            file=buffer,
        )
        transcript = transcription.text.strip()
        if not transcript:
            raise ValueError("empty transcript")
    except Exception:
        fallback = local_fallback(context, "")
        return VoiceCompanionResponse(
            **fallback.model_dump(),
            transcript="I couldn’t transcribe that recording. Typed chat is still available.",
        )

    companion = await create_companion_response(context, transcript)
    audio_base64: str | None = None

    if companion.used_ai:
        try:
            speech = await _client().audio.speech.create(
                model=os.environ.get("OPENAI_TTS_MODEL", "gpt-4o-mini-tts"),
                voice=os.environ.get("OPENAI_TTS_VOICE", "coral"),
                input=companion.text,
                instructions="Speak warmly, naturally, and calmly. Keep the tone supportive but not clinical.",
                response_format="mp3",
            )
            audio_base64 = base64.b64encode(speech.content).decode("ascii")
        except Exception:
            audio_base64 = None

    return VoiceCompanionResponse(
        **companion.model_dump(),
        transcript=transcript,
        audio_base64=audio_base64,
        audio_mime_type="audio/mpeg" if audio_base64 else None,
        audio_available=audio_base64 is not None,
    )
