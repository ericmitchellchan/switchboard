interface PulsingDotProps {
  color: string;
  pulse: boolean;
  size?: number;
}

export function PulsingDot({ color, pulse, size = 7 }: PulsingDotProps) {
  const outerSize = size + 3;
  return (
    <span
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: outerSize,
        height: outerSize,
      }}
    >
      {pulse && (
        <span
          style={{
            position: "absolute",
            width: outerSize,
            height: outerSize,
            borderRadius: "50%",
            backgroundColor: color,
            opacity: 0.4,
            animation: "pulse-ring 2s ease-in-out infinite",
          }}
        />
      )}
      <span
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          backgroundColor: color,
          position: "relative",
        }}
      />
    </span>
  );
}
