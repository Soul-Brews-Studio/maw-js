import { useEffect, useRef, useState, useCallback } from "react";
import { wsUrl } from "../lib/api";

type MessageHandler = (data: any) => void;

const BASE_DELAY = 1000;
const MAX_DELAY = 30000;

export function useWebSocket(onMessage: MessageHandler) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    let alive = true;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let attempt = 0;

    function connect() {
      if (!alive) return;
      const ws = new WebSocket(wsUrl("/ws"));
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
        setReconnecting(false);
      };
      ws.onmessage = (e) => {
        try { onMessageRef.current(JSON.parse(e.data)); } catch {}
      };
      ws.onclose = () => {
        setConnected(false);
        if (alive) {
          setReconnecting(true);
          const delay = Math.min(BASE_DELAY * 2 ** attempt, MAX_DELAY);
          attempt++;
          reconnectTimer = setTimeout(connect, delay);
        }
      };
      ws.onerror = () => ws.close();
    }

    connect();
    return () => {
      alive = false;
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, []);

  const send = useCallback((msg: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  return { connected, reconnecting, send };
}
