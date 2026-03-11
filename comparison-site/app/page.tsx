import CapabilityMatrix from "@/components/CapabilityMatrix";

export default function Page() {
  return (
    <div className="min-h-screen" style={{ background: "var(--bg)" }}>
      <div className="max-w-[1500px] mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {/* Header */}
        <header
          className="mb-10 py-10 px-6 text-center relative"
          style={{
            background: "linear-gradient(135deg, var(--surface) 0%, rgba(122, 103, 248, 0.08) 100%)",
            borderBottom: "1.5px solid var(--border)",
            borderRadius: "var(--radius-lg)",
          }}
        >
          <div
            className="absolute bottom-0 left-0 right-0 h-px"
            style={{
              background: "linear-gradient(90deg, transparent, var(--uno-violet), transparent)",
              opacity: 0.4,
            }}
          />
          <h1
            className="text-3xl sm:text-4xl font-black tracking-tight"
            style={{ color: "white" }}
          >
            Figma AI Plugin Capability Matrix
          </h1>
        </header>

        {/* Matrix */}
        <CapabilityMatrix />
      </div>
    </div>
  );
}
