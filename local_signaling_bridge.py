"""
Local Signaling Bridge: HTTP (SDK protocol) ↔ WebSocket (GStreamer protocol).

Runs on http://localhost:9090 and translates between:
  - SDK's HTTP SSE (GET /events) + POST /send + GET /api/robot-status
  - GStreamer's WebSocket at ws://127.0.0.1:8443

This is a pure local bridge — no HF Space involved, no SSE timeout issues.
"""

import asyncio
import json
import logging
import uuid
from typing import Any, Optional

import websockets
from aiohttp import web

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("bridge")

GSTREAMER_URL = "ws://127.0.0.1:8443"

# ─── Shared state ─────────────────────────────────────────────────────────────

gst_ws: Optional[Any] = None          # WebSocket to GStreamer
gst_peer_id: Optional[str] = None     # Our peer ID in GStreamer
gst_producer_id: Optional[str] = None # The GStreamer webrtcsink producer

# Session mapping
central_to_gst: dict[str, str] = {}   # fake central session → real GStreamer session
gst_to_central: dict[str, str] = {}   # real GStreamer session → fake central session
pending_sessions: list[str] = []       # central session IDs waiting for GStreamer sessionStarted

# SSE clients: each browser tab gets its own queue
sse_queues: list[asyncio.Queue] = []

# Lock for shared state
state_lock = asyncio.Lock()


async def broadcast_sse(msg: dict) -> None:
    """Send a message to all connected SSE clients."""
    data = f"data:{json.dumps(msg)}\n\n"
    dead = []
    for q in sse_queues:
        try:
            q.put_nowait(data)
        except asyncio.QueueFull:
            dead.append(q)
    for q in dead:
        sse_queues.remove(q)


async def send_to_gst(msg: dict) -> None:
    """Send a message to GStreamer WebSocket."""
    if gst_ws:
        await gst_ws.send(json.dumps(msg))


# ─── GStreamer WebSocket listener ─────────────────────────────────────────────

async def gstreamer_listener():
    """Connect to GStreamer and forward messages to SSE clients."""
    global gst_ws, gst_peer_id, gst_producer_id

    while True:
        try:
            logger.info(f"Connecting to GStreamer at {GSTREAMER_URL}...")
            async with websockets.connect(GSTREAMER_URL) as ws:
                gst_ws = ws

                # Read welcome
                welcome = json.loads(await asyncio.wait_for(ws.recv(), 5))
                gst_peer_id = welcome["peerId"]
                logger.info(f"GStreamer connected, my peer_id={gst_peer_id}")

                # Register as listener
                await ws.send(json.dumps({"type": "setPeerStatus", "roles": ["listener"]}))
                await asyncio.wait_for(ws.recv(), 3)  # ack

                # Get initial producer list
                await ws.send(json.dumps({"type": "list"}))
                list_msg = json.loads(await asyncio.wait_for(ws.recv(), 3))
                producers = list_msg.get("producers", [])
                if producers:
                    gst_producer_id = producers[0]["id"]
                    logger.info(f"GStreamer producer found: {gst_producer_id}")
                else:
                    logger.warning("No GStreamer producer found yet")

                # Listen for messages
                async for raw in ws:
                    msg = json.loads(raw)
                    mtype = msg.get("type", "")
                    logger.debug(f"GStreamer → {mtype}")

                    if mtype == "peerStatusChanged":
                        roles = msg.get("roles", [])
                        if "producer" in roles:
                            gst_producer_id = msg.get("peerId")
                            logger.info(f"New GStreamer producer: {gst_producer_id}")
                            # Notify SSE clients of producer change
                            await broadcast_sse({
                                "type": "peerStatusChanged",
                                "peerId": gst_producer_id,
                                "roles": ["producer"],
                            })

                    elif mtype == "sessionStarted":
                        gst_sess = msg.get("sessionId")
                        logger.info(f"GStreamer sessionStarted: {gst_sess}")
                        async with state_lock:
                            if pending_sessions:
                                c_sess = pending_sessions.pop(0)
                                central_to_gst[c_sess] = gst_sess
                                gst_to_central[gst_sess] = c_sess
                                logger.info(f"Session mapped: central={c_sess} ↔ gst={gst_sess}")
                                # Forward sessionStarted to SSE
                                await broadcast_sse({
                                    "type": "sessionStarted",
                                    "sessionId": c_sess,
                                    "peerId": gst_producer_id,
                                })

                    elif mtype == "peer":
                        gst_sess = msg.get("sessionId")
                        async with state_lock:
                            c_sess = gst_to_central.get(gst_sess)
                        if c_sess:
                            fwd = {"type": "peer", "sessionId": c_sess}
                            if "sdp" in msg:
                                fwd["sdp"] = msg["sdp"]
                            if "ice" in msg:
                                fwd["ice"] = msg["ice"]
                            await broadcast_sse(fwd)
                            logger.debug(f"GStreamer→SSE: peer (sess={c_sess[:8]}...)")

                    elif mtype == "endSession":
                        gst_sess = msg.get("sessionId")
                        async with state_lock:
                            c_sess = gst_to_central.pop(gst_sess, None)
                            if c_sess:
                                central_to_gst.pop(c_sess, None)
                        if c_sess:
                            await broadcast_sse({"type": "endSession", "sessionId": c_sess})

                    elif mtype == "list":
                        # Updated producer list
                        producers = msg.get("producers", [])
                        if producers:
                            gst_producer_id = producers[0]["id"]

        except Exception as e:
            logger.error(f"GStreamer connection error: {e}")
            gst_ws = None
            await asyncio.sleep(2)


# ─── HTTP handlers ────────────────────────────────────────────────────────────

async def handle_events(request: web.Request) -> web.StreamResponse:
    """SSE endpoint: GET /events — mirrors central's SSE protocol."""
    response = web.StreamResponse(
        status=200,
        headers={
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
        },
    )
    await response.prepare(request)

    # Create a queue for this client
    q: asyncio.Queue = asyncio.Queue(maxsize=100)
    sse_queues.append(q)
    client_peer_id = str(uuid.uuid4())

    try:
        # Send welcome
        welcome = f'data:{json.dumps({"type": "welcome", "peerId": client_peer_id, "username": "local"})}\n\n'
        await response.write(welcome.encode())

        # Send initial producer list
        if gst_producer_id:
            list_msg = f'data:{json.dumps({"type": "list", "producers": [{"id": gst_producer_id, "meta": {"name": "reachy_mini"}}]})}\n\n'
            await response.write(list_msg.encode())
        else:
            await response.write(f'data:{json.dumps({"type": "list", "producers": []})}\n\n'.encode())

        # Forward queued messages + periodic keepalive
        while True:
            try:
                data = await asyncio.wait_for(q.get(), timeout=15)
                await response.write(data.encode())
            except asyncio.TimeoutError:
                # SSE keepalive comment
                await response.write(b":keepalive\n\n")
            except ConnectionResetError:
                break

    finally:
        if q in sse_queues:
            sse_queues.remove(q)
        logger.info(f"SSE client {client_peer_id[:8]}... disconnected")

    return response


async def handle_send(request: web.Request) -> web.Response:
    """POST /send — mirrors central's message relay."""
    try:
        msg = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)

    mtype = msg.get("type", "")
    logger.info(f"SDK → /send: {mtype}")

    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
    }

    if mtype == "setPeerStatus":
        # SDK registers as listener - just ack
        return web.json_response({"type": "peerStatusChanged", "roles": msg.get("roles", [])}, headers=headers)

    elif mtype == "list":
        # Return GStreamer producer list
        producers = []
        if gst_producer_id:
            producers = [{"id": gst_producer_id, "meta": {"name": "reachy_mini"}}]
        return web.json_response({"type": "list", "producers": producers}, headers=headers)

    elif mtype == "startSession":
        robot_id = msg.get("peerId")
        c_sess = str(uuid.uuid4())
        logger.info(f"startSession: robot={robot_id}, central_session={c_sess}")

        if not gst_ws or not gst_producer_id:
            return web.json_response(
                {"type": "sessionRejected", "reason": "robot_offline"},
                headers=headers,
            )

        async with state_lock:
            pending_sessions.append(c_sess)

        # Start session with GStreamer
        await send_to_gst({"type": "startSession", "peerId": gst_producer_id})
        logger.info(f"→ GStreamer: startSession peerId={gst_producer_id}")

        # Wait for sessionStarted (max 5 seconds)
        for _ in range(50):
            await asyncio.sleep(0.1)
            async with state_lock:
                if c_sess in central_to_gst:
                    return web.json_response(
                        {"type": "sessionStarted", "sessionId": c_sess, "peerId": robot_id},
                        headers=headers,
                    )

        # Timeout
        async with state_lock:
            if c_sess in pending_sessions:
                pending_sessions.remove(c_sess)
        logger.warning("startSession timeout — GStreamer didn't respond")
        return web.json_response(
            {"type": "sessionRejected", "reason": "timeout"},
            headers=headers,
        )

    elif mtype == "peer":
        c_sess = msg.get("sessionId")
        async with state_lock:
            gst_sess = central_to_gst.get(c_sess)
        if not gst_sess:
            logger.warning(f"peer: no GStreamer session for central {c_sess}")
            return web.json_response({"ok": False}, headers=headers)

        fwd = {"type": "peer", "sessionId": gst_sess}
        if "sdp" in msg:
            fwd["sdp"] = msg["sdp"]
        if "ice" in msg:
            fwd["ice"] = msg["ice"]
        await send_to_gst(fwd)
        logger.debug(f"SDK→GStreamer: peer (gst_sess={gst_sess[:8]}...)")
        return web.json_response({"ok": True}, headers=headers)

    elif mtype == "endSession":
        c_sess = msg.get("sessionId")
        async with state_lock:
            gst_sess = central_to_gst.pop(c_sess, None)
            if gst_sess:
                gst_to_central.pop(gst_sess, None)
        if gst_sess:
            await send_to_gst({"type": "endSession", "sessionId": gst_sess})
        return web.json_response({"ok": True}, headers=headers)

    return web.json_response({"ok": True}, headers=headers)


async def handle_robot_status(request: web.Request) -> web.Response:
    """GET /api/robot-status — returns available robots."""
    robots = []
    if gst_producer_id:
        robots.append({
            "peerId": gst_producer_id,
            "robotName": "reachy_mini",
            "busy": False,
            "activeApp": None,
            "meta": {"name": "reachy_mini"},
            "last_seen_age_seconds": 1.0,
        })
    return web.json_response(
        {"robots": robots},
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
        },
    )


async def handle_cors_preflight(request: web.Request) -> web.Response:
    """Handle CORS preflight for all routes."""
    return web.Response(
        status=200,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
        },
    )


async def start_background_tasks(app: web.Application) -> None:
    app["gst_listener"] = asyncio.create_task(gstreamer_listener())


async def cleanup_background_tasks(app: web.Application) -> None:
    app["gst_listener"].cancel()


def main() -> None:
    app = web.Application()

    # CORS preflight for all routes
    app.router.add_route("OPTIONS", "/{path:.*}", handle_cors_preflight)

    # SDK endpoints
    app.router.add_get("/events", handle_events)
    app.router.add_post("/send", handle_send)
    app.router.add_get("/api/robot-status", handle_robot_status)

    app.on_startup.append(start_background_tasks)
    app.on_cleanup.append(cleanup_background_tasks)

    logger.info("Starting local signaling bridge on http://localhost:9090")
    web.run_app(app, host="127.0.0.1", port=9090, print=lambda x: logger.info(x))


if __name__ == "__main__":
    main()
