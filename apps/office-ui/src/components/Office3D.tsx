import { Canvas, useFrame } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import { useRef } from "react";
import type { Group, Mesh, MeshStandardMaterial } from "three";
import { STATUS_COLOR, STATUS_LABEL, type Seat } from "../types.ts";

function Desk({ seat, selected, onSelect }: { seat: Seat; selected: boolean; onSelect: (id: string) => void }) {
  const avatar = useRef<Group>(null);
  const ring = useRef<Mesh>(null);
  const beacon = useRef<MeshStandardMaterial>(null);
  const statusColor = STATUS_COLOR[seat.status];
  const offline = seat.status === "offline";

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (avatar.current) {
      const bob = seat.status === "thinking" ? Math.sin(t * 4) * 0.08 : 0;
      avatar.current.position.y = 0.95 + bob;
      const pulse = seat.status === "waiting_approval" ? 1 + Math.abs(Math.sin(t * 5)) * 0.25 : 1;
      avatar.current.scale.setScalar(pulse);
    }
    if (ring.current) {
      ring.current.rotation.z = seat.status === "calling_tool" ? t * 3 : 0;
      ring.current.visible = seat.status === "calling_tool" || seat.status === "waiting_approval";
    }
    if (beacon.current) {
      beacon.current.emissiveIntensity =
        seat.status === "waiting_approval" ? 1.5 + Math.sin(t * 8) * 1.2 : seat.status === "error" ? 1.2 : 0.4;
    }
  });

  return (
    <group
      position={seat.position}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(seat.id);
      }}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "auto")}
    >
      {/* floor tile highlight */}
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.01, 0]} receiveShadow>
        <circleGeometry args={[1.35, 40]} />
        <meshStandardMaterial color={selected ? "#2a3b5c" : "#1b2333"} />
      </mesh>
      {/* desk */}
      <mesh position={[0, 0.75, -0.55]} castShadow>
        <boxGeometry args={[1.8, 0.08, 0.8]} />
        <meshStandardMaterial color={offline ? "#3a3f4b" : "#8d6e52"} />
      </mesh>
      {[-0.8, 0.8].map((x) => (
        <mesh key={x} position={[x, 0.37, -0.55]}>
          <boxGeometry args={[0.06, 0.74, 0.7]} />
          <meshStandardMaterial color="#4a4f5c" />
        </mesh>
      ))}
      {/* monitor glows with status */}
      <mesh position={[0, 1.12, -0.8]}>
        <boxGeometry args={[0.9, 0.55, 0.05]} />
        <meshStandardMaterial ref={beacon} color="#111" emissive={statusColor} emissiveIntensity={0.4} />
      </mesh>
      {/* avatar */}
      <group ref={avatar} position={[0, 0.95, 0.15]}>
        <mesh castShadow>
          <capsuleGeometry args={[0.22, 0.35, 6, 16]} />
          <meshStandardMaterial color={offline ? "#555b66" : seat.color} transparent opacity={offline ? 0.45 : 1} />
        </mesh>
        <mesh position={[0, 0.5, 0]}>
          <sphereGeometry args={[0.07, 16, 16]} />
          <meshStandardMaterial color={statusColor} emissive={statusColor} emissiveIntensity={1} />
        </mesh>
      </group>
      <mesh ref={ring} rotation-x={-Math.PI / 2} position={[0, 0.05, 0.15]} visible={false}>
        <torusGeometry args={[0.6, 0.04, 8, 48]} />
        <meshStandardMaterial color={statusColor} emissive={statusColor} emissiveIntensity={1.5} />
      </mesh>
      {seat.status === "waiting_approval" && <pointLight position={[0, 1.8, 0]} color="#ff8a00" intensity={6} distance={4} />}
      <Html position={[0, 1.9, 0.2]} center distanceFactor={13} zIndexRange={[10, 0]}>
        <div className={`desk-label ${seat.status} ${selected ? "selected" : ""}`} onClick={() => onSelect(seat.id)}>
          <strong>{seat.name}</strong>
          <span>{STATUS_LABEL[seat.status]}</span>
        </div>
      </Html>
    </group>
  );
}

const BOOK_ROWS: Array<{ y: number; books: Array<{ x: number; w: number; h: number; color: string }> }> = [
  {
    y: 0.42,
    books: [
      { x: -0.68, w: 0.16, h: 0.42, color: "#4f9dff" },
      { x: -0.46, w: 0.18, h: 0.36, color: "#ffd166" },
      { x: -0.22, w: 0.16, h: 0.44, color: "#06d6a0" },
      { x: 0.04, w: 0.2, h: 0.38, color: "#ef476f" },
      { x: 0.3, w: 0.16, h: 0.43, color: "#c77dff" },
      { x: 0.56, w: 0.2, h: 0.35, color: "#8ecae6" },
    ],
  },
  {
    y: 1.02,
    books: [
      { x: -0.64, w: 0.2, h: 0.4, color: "#06d6a0" },
      { x: -0.38, w: 0.16, h: 0.45, color: "#ff8a00" },
      { x: -0.14, w: 0.18, h: 0.36, color: "#4f9dff" },
      { x: 0.14, w: 0.18, h: 0.42, color: "#ffd166" },
      { x: 0.42, w: 0.22, h: 0.38, color: "#c77dff" },
    ],
  },
  {
    y: 1.62,
    books: [
      { x: -0.6, w: 0.18, h: 0.38, color: "#ef476f" },
      { x: -0.34, w: 0.22, h: 0.42, color: "#8ecae6" },
      { x: -0.04, w: 0.16, h: 0.36, color: "#06d6a0" },
      { x: 0.22, w: 0.2, h: 0.44, color: "#4f9dff" },
      { x: 0.52, w: 0.18, h: 0.35, color: "#ffd166" },
    ],
  },
];

function LibraryBookshelf({ active, onOpen }: { active: boolean; onOpen: () => void }) {
  return (
    <group
      position={[6.2, 0, -5.2]}
      rotation={[0, -Math.PI / 6, 0]}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "auto")}
    >
      {/* floor highlight */}
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.01, 0]} receiveShadow>
        <circleGeometry args={[1.45, 40]} />
        <meshStandardMaterial color={active ? "#2a3b5c" : "#1b2636"} />
      </mesh>
      {/* back panel */}
      <mesh position={[0, 1.1, -0.22]} castShadow>
        <boxGeometry args={[1.8, 2.2, 0.06]} />
        <meshStandardMaterial color="#5b4330" />
      </mesh>
      {/* side panels */}
      {[-0.87, 0.87].map((x) => (
        <mesh key={x} position={[x, 1.1, 0]} castShadow>
          <boxGeometry args={[0.08, 2.2, 0.48]} />
          <meshStandardMaterial color="#75563d" />
        </mesh>
      ))}
      {/* shelves */}
      {[0.14, 0.74, 1.34, 1.94, 2.18].map((y) => (
        <mesh key={y} position={[0, y, 0]} castShadow>
          <boxGeometry args={[1.82, 0.07, 0.5]} />
          <meshStandardMaterial color="#8d6e52" />
        </mesh>
      ))}
      {/* books */}
      {BOOK_ROWS.map((row) =>
        row.books.map((b, idx) => (
          <mesh key={`${row.y}-${idx}`} position={[b.x, row.y, 0.02]} castShadow>
            <boxGeometry args={[b.w, b.h, 0.32]} />
            <meshStandardMaterial
              color={b.color}
              emissive={active ? b.color : "#000000"}
              emissiveIntensity={active ? 0.25 : 0}
            />
          </mesh>
        ))
      )}
      <Html position={[0, 2.55, 0]} center distanceFactor={13} zIndexRange={[10, 0]}>
        <div
          className={`desk-label library ${active ? "selected" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          <strong>Thư viện</strong>
          <span>Kho ~/.cursor</span>
        </div>
      </Html>
    </group>
  );
}

export default function Office3D({
  seats,
  selectedId,
  onSelect,
  libraryOpen,
  onOpenLibrary,
  paused,
}: {
  seats: Seat[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  libraryOpen: boolean;
  onOpenLibrary: () => void;
  paused: boolean;
}) {
  return (
    <Canvas
      shadows
      dpr={[1, 1.5]}
      frameloop={paused ? "never" : "always"}
      camera={{ position: [0, 9.5, 10.5], fov: 45 }}
      onPointerMissed={() => onSelect(null)}
      gl={{ powerPreference: "low-power", antialias: true }}
    >
      <color attach="background" args={["#0d1117"]} />
      <ambientLight intensity={0.55} />
      <directionalLight position={[6, 10, 4]} intensity={1.1} castShadow shadow-mapSize={[1024, 1024]} />
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[20, 20]} />
        <meshStandardMaterial color="#161b22" />
      </mesh>
      <gridHelper args={[20, 20, "#30363d", "#21262d"]} position={[0, 0.005, 0]} />
      {seats.map((s) => (
        <Desk key={s.id} seat={s} selected={s.id === selectedId} onSelect={onSelect} />
      ))}
      <LibraryBookshelf active={libraryOpen} onOpen={onOpenLibrary} />
      <OrbitControls
        enablePan={false}
        minDistance={6}
        maxDistance={24}
        maxPolarAngle={Math.PI / 2.2}
        target={[0, 0.5, 0]}
      />
    </Canvas>
  );
}
