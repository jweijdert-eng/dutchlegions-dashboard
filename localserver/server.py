"""
Dutch Legions - Local Chat Server
Leest EVE Online Local chat logs en stuurt ze via WebSocket naar het dashboard.
"""

import asyncio
import glob
import json
import os
import re
import time
import websockets

# Pad naar EVE chat logs (pas aan als EVE ergens anders staat)
LOG_DIR = os.path.expandvars(r"%USERPROFILE%\Documents\EVE\logs\Chatlogs")

# Regex voor chatberichten: [ 2024.01.12 14:30:00 ] Naam > Bericht
MSG_RE = re.compile(r'^\[ (\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}) \] (.+?) > (.+)$')

clients = set()


def find_latest_local_log():
    """Zoek het meest recente Local_*.txt bestand."""
    pattern = os.path.join(LOG_DIR, "Local_*.txt")
    files = glob.glob(pattern)
    if not files:
        return None
    return max(files, key=os.path.getmtime)


async def broadcast(msg: dict):
    if not clients:
        return
    data = json.dumps(msg)
    await asyncio.gather(*[c.send(data) for c in list(clients)], return_exceptions=True)


async def watch_log():
    """Kijk continu naar nieuwe regels in het Local log bestand."""
    current_file = None
    file_handle = None
    last_check = 0

    while True:
        await asyncio.sleep(1)

        # Controleer elke 10 seconden of er een nieuwer logbestand is
        now = time.time()
        if now - last_check > 10:
            last_check = now
            latest = find_latest_local_log()
            if latest != current_file:
                if file_handle:
                    file_handle.close()
                current_file = latest
                if current_file:
                    print(f"Logbestand gevonden: {os.path.basename(current_file)}")
                    file_handle = open(current_file, 'r', encoding='utf-8', errors='replace')
                    file_handle.seek(0, 2)  # Ga naar het einde
                    await broadcast({"type": "status", "file": os.path.basename(current_file)})
                else:
                    print("Geen Local logbestand gevonden.")
                    await broadcast({"type": "status", "file": None})

        if not file_handle:
            continue

        # Lees nieuwe regels
        while True:
            line = file_handle.readline()
            if not line:
                break
            line = line.strip()
            m = MSG_RE.match(line)
            if m:
                time_str, sender, message = m.group(1), m.group(2), m.group(3)
                msg = {
                    "type": "message",
                    "time": time_str.replace('.', '-', 2).replace(' ', 'T'),
                    "sender": sender,
                    "message": message,
                }
                print(f"[{time_str}] {sender}: {message}")
                await broadcast(msg)


async def handler(websocket):
    clients.add(websocket)
    print(f"Dashboard verbonden ({len(clients)} actief)")
    try:
        # Stuur huidige status
        latest = find_latest_local_log()
        await websocket.send(json.dumps({
            "type": "status",
            "file": os.path.basename(latest) if latest else None
        }))
        await websocket.wait_closed()
    finally:
        clients.discard(websocket)
        print(f"Dashboard verbroken ({len(clients)} actief)")


async def main():
    print("=== Dutch Legions Local Chat Server ===")
    print(f"Log map: {LOG_DIR}")
    if not os.path.exists(LOG_DIR):
        print(f"WAARSCHUWING: Map niet gevonden: {LOG_DIR}")
        print("Pas LOG_DIR aan in server.py als EVE ergens anders staat.")
    print("WebSocket server gestart op ws://localhost:8765")
    print("Laat dit venster open terwijl je het dashboard gebruikt.")
    print()

    async with websockets.serve(handler, "localhost", 8765):
        await watch_log()


if __name__ == "__main__":
    asyncio.run(main())
