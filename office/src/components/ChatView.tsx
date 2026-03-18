import { useState } from "react";
import type { AgentState } from "../lib/types";

interface ChatViewProps {
  agents: AgentState[];
  send: (msg: any) => void;
  connected: boolean;
}

export function ChatView({ agents, send, connected }: ChatViewProps) {
  const [selectedAgent, setSelectedAgent] = useState<AgentState | null>(null);
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<Array<{ from: string; text: string; time: string }>>([
    { from: "System", text: "Welcome to Agent Chat. Select an agent to send a message.", time: new Date().toLocaleTimeString() }
  ]);

  const handleSend = () => {
    if (!selectedAgent || !message.trim()) return;

    const userMessage = {
      type: "chat",
      target: selectedAgent.target,
      text: message,
    };

    send(userMessage);

    setMessages(prev => [...prev, {
      from: "You",
      text: message,
      time: new Date().toLocaleTimeString()
    }]);

    setMessage("");
  };

  return (
    <div className="flex h-full">
      {/* Agent List */}
      <div className="w-64 border-r border-gray-800 p-4 overflow-y-auto">
        <h2 className="text-lg font-bold text-white mb-4">Agents</h2>
        <div className="space-y-2">
          {agents.map(agent => (
            <button
              key={agent.target}
              onClick={() => setSelectedAgent(agent)}
              className={`w-full text-left p-3 rounded-lg transition-colors ${
                selectedAgent?.target === agent.target
                  ? "bg-blue-600 text-white"
                  : "bg-gray-800 text-gray-300 hover:bg-gray-700"
              }`}
            >
              <div className="font-medium">{agent.target}</div>
              <div className="text-sm opacity-70 capitalize">{agent.status}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Chat Area */}
      <div className="flex-1 flex flex-col">
        <div className="p-4 border-b border-gray-800">
          <h1 className="text-xl font-bold text-white">
            {selectedAgent ? `Chat with ${selectedAgent.target}` : "Agent Chat"}
          </h1>
          {!connected && (
            <div className="mt-2 text-sm text-red-400">⚠️ Disconnected from server</div>
          )}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.map((msg, idx) => (
            <div key={idx} className={`flex ${msg.from === "You" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[70%] rounded-lg p-3 ${
                msg.from === "You"
                  ? "bg-blue-600 text-white"
                  : "bg-gray-800 text-gray-200"
              }`}>
                <div className="text-sm font-medium mb-1">{msg.from}</div>
                <div>{msg.text}</div>
                <div className="text-xs opacity-60 mt-1">{msg.time}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Input */}
        <div className="p-4 border-t border-gray-800">
          <div className="flex gap-2">
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyPress={(e) => e.key === "Enter" && handleSend()}
              placeholder={selectedAgent ? `Message ${selectedAgent.target}...` : "Select an agent first..."}
              disabled={!selectedAgent || !connected}
              className="flex-1 px-4 py-2 rounded-lg bg-gray-800 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
            />
            <button
              onClick={handleSend}
              disabled={!selectedAgent || !connected || !message.trim()}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
