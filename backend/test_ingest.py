import asyncio
from backend.pipeline.ingest import ingest_session
from backend.db.queries import get_stints, get_laps

session_key = ingest_session(2024, 1, session_type="R")
print("Session Key:", session_key)
stints = get_stints(session_key)
print("Stints Count:", len(stints))
laps = get_laps(session_key)
print("Laps Count:", len(laps))
