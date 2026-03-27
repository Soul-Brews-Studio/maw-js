export function LoadingSkeleton() {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="text-white/30 text-sm font-mono animate-pulse">Connecting...</div>
    </div>
  );
}
