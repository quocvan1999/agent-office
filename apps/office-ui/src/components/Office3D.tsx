import { Canvas, useFrame } from "@react-three/fiber";
import { Html, Line, OrbitControls } from "@react-three/drei";
import { useMemo, useRef } from "react";
import type { Group, Mesh, MeshStandardMaterial } from "three";
import {
  CONVERSATION_TYPE_LABEL,
  GROK_BOT_BADGE,
  SLOT_STATUS_COLOR,
  STATUS_COLOR,
  STATUS_LABEL,
  type AccountSlot,
  type BusMessage,
  type Conversation,
  type DepartmentZone,
  type Seat,
} from "../types.ts";

const CONV_LINE_COLORS = ["#4cc9f0", "#ffd166", "#06d6a0", "#f72585", "#c77dff"];

function Desk({
  seat,
  selected,
  speaking,
  onSelect,
}: {
  seat: Seat;
  selected: boolean;
  speaking: boolean;
  onSelect: (id: string) => void;
}) {
  const avatar = useRef<Group>(null);
  const ring = useRef<Mesh>(null);
  const speakRing = useRef<Mesh>(null);
  const beacon = useRef<MeshStandardMaterial>(null);
  const statusColor = STATUS_COLOR[seat.status];
  const offline = seat.status === "offline";
  const isGrokBot = seat.orgKind === "grok_bot" || seat.orgProvider === "grok_external";

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (avatar.current) {
      const bob = seat.status === "thinking" || speaking ? Math.sin(t * 4.5) * 0.08 : 0;
      avatar.current.position.y = 0.95 + bob;
      const pulse =
        seat.status === "waiting_approval"
          ? 1 + Math.abs(Math.sin(t * 5)) * 0.25
          : speaking
            ? 1 + Math.abs(Math.sin(t * 4)) * 0.12
            : 1;
      avatar.current.scale.setScalar(pulse);
    }
    if (ring.current) {
      ring.current.rotation.z = seat.status === "calling_tool" ? t * 3 : 0;
      ring.current.visible = seat.status === "calling_tool" || seat.status === "waiting_approval";
    }
    if (speakRing.current) {
      speakRing.current.visible = speaking;
      if (speaking) {
        const s = 1 + Math.sin(t * 5) * 0.08;
        speakRing.current.scale.set(s, s, 1);
      }
    }
    if (beacon.current) {
      beacon.current.emissiveIntensity =
        seat.status === "waiting_approval"
          ? 1.5 + Math.sin(t * 8) * 1.2
          : speaking
            ? 1.2 + Math.sin(t * 6) * 0.5
            : seat.status === "error"
              ? 1.2
              : 0.4;
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
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.025, 0]} receiveShadow>
        <circleGeometry args={[0.92, 32]} />
        <meshStandardMaterial color={selected ? "#2a3b5c" : speaking ? "#1d3a4b" : "#1b2333"} />
      </mesh>
      {/* desk */}
      <mesh position={[0, 0.72, -0.42]} castShadow>
        <boxGeometry args={[1.45, 0.07, 0.65]} />
        <meshStandardMaterial color={offline ? "#3a3f4b" : "#8d6e52"} />
      </mesh>
      {[-0.64, 0.64].map((x) => (
        <mesh key={x} position={[x, 0.36, -0.42]}>
          <boxGeometry args={[0.05, 0.72, 0.56]} />
          <meshStandardMaterial color="#4a4f5c" />
        </mesh>
      ))}
      {/* monitor glows with status */}
      <mesh position={[0, 1.05, -0.62]}>
        <boxGeometry args={[0.75, 0.45, 0.05]} />
        <meshStandardMaterial
          ref={beacon}
          color="#111"
          emissive={speaking ? "#4cc9f0" : statusColor}
          emissiveIntensity={0.4}
        />
      </mesh>
      {/* avatar */}
      <group ref={avatar} position={[0, 0.95, 0.14]}>
        <mesh castShadow>
          <capsuleGeometry args={[0.2, 0.32, 6, 16]} />
          <meshStandardMaterial
            color={offline ? "#555b66" : seat.color}
            emissive={speaking ? "#4cc9f0" : "#000000"}
            emissiveIntensity={speaking ? 0.35 : 0}
            transparent
            opacity={offline ? 0.45 : 1}
          />
        </mesh>
        <mesh position={[0, 0.46, 0]}>
          <sphereGeometry args={[0.065, 16, 16]} />
          <meshStandardMaterial color={statusColor} emissive={statusColor} emissiveIntensity={1} />
        </mesh>
      </group>
      <mesh ref={ring} rotation-x={-Math.PI / 2} position={[0, 0.06, 0.14]} visible={false}>
        <torusGeometry args={[0.52, 0.035, 8, 40]} />
        <meshStandardMaterial color={statusColor} emissive={statusColor} emissiveIntensity={1.5} />
      </mesh>
      <mesh ref={speakRing} rotation-x={-Math.PI / 2} position={[0, 0.065, 0.14]} visible={false}>
        <torusGeometry args={[0.68, 0.045, 8, 44]} />
        <meshStandardMaterial color="#4cc9f0" emissive="#4cc9f0" emissiveIntensity={1.8} />
      </mesh>
      {seat.status === "waiting_approval" && <pointLight position={[0, 1.8, 0]} color="#ff8a00" intensity={5} distance={4} />}
      {speaking && <pointLight position={[0, 1.8, 0.1]} color="#4cc9f0" intensity={4} distance={4.5} />}
      <Html position={[0, 1.82, 0.16]} center distanceFactor={16} zIndexRange={[10, 0]}>
        <div
          className={`desk-label ${seat.status} ${selected ? "selected" : ""} ${speaking ? "speaking" : ""}`}
          onClick={() => onSelect(seat.id)}
        >
          <strong>
            {seat.name}
            {seat.isHead ? " ★" : ""}
          </strong>
          <span>{STATUS_LABEL[seat.status]}</span>
          {isGrokBot && <em className="grok-badge">{GROK_BOT_BADGE}</em>}
        </div>
      </Html>
    </group>
  );
}

function DepartmentZoneTile({ zone }: { zone: DepartmentZone }) {
  const [w, d] = zone.size;
  const borderThickness = 0.07;

  return (
    <group position={zone.position}>
      {/* colored floor tile */}
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.012, 0]} receiveShadow>
        <planeGeometry args={[w, d]} />
        <meshStandardMaterial color={zone.color} transparent opacity={0.14} />
      </mesh>
      {/* subtle perimeter strips */}
      <mesh position={[0, 0.018, -d / 2]}>
        <boxGeometry args={[w, 0.012, borderThickness]} />
        <meshStandardMaterial color={zone.color} emissive={zone.color} emissiveIntensity={0.35} />
      </mesh>
      <mesh position={[0, 0.018, d / 2]}>
        <boxGeometry args={[w, 0.012, borderThickness]} />
        <meshStandardMaterial color={zone.color} emissive={zone.color} emissiveIntensity={0.35} />
      </mesh>
      <mesh position={[-w / 2, 0.018, 0]}>
        <boxGeometry args={[borderThickness, 0.012, d]} />
        <meshStandardMaterial color={zone.color} emissive={zone.color} emissiveIntensity={0.35} />
      </mesh>
      <mesh position={[w / 2, 0.018, 0]}>
        <boxGeometry args={[borderThickness, 0.012, d]} />
        <meshStandardMaterial color={zone.color} emissive={zone.color} emissiveIntensity={0.35} />
      </mesh>
      {/* zone label + head name */}
      <Html position={[0, 0.16, -d / 2 - 0.35]} center distanceFactor={19} zIndexRange={[5, 0]}>
        <div className="zone-label" style={{ borderColor: zone.color }}>
          <strong>{zone.name}</strong>
          <span>{zone.headName ? `Trưởng phòng: ${zone.headName}` : "Chưa có trưởng phòng"}</span>
        </div>
      </Html>
    </group>
  );
}

function MeetingTable({
  active,
  openConversations,
  seatsById,
  latestMsgByConv,
  onOpenMeeting,
}: {
  active: boolean;
  openConversations: Conversation[];
  seatsById: Map<string, Seat>;
  latestMsgByConv: Map<string, BusMessage>;
  onOpenMeeting: (conversationId?: string) => void;
}) {
  const glowRing = useRef<Mesh>(null);
  const hasOpen = openConversations.length > 0;

  useFrame(({ clock }) => {
    if (glowRing.current) {
      glowRing.current.visible = hasOpen || active;
      if (hasOpen) {
        const s = 1 + Math.sin(clock.getElapsedTime() * 2.5) * 0.03;
        glowRing.current.scale.set(s, s, 1);
      }
    }
  });

  return (
    <group position={[0, 0, 0]}>
      {/* meeting carpet */}
      <mesh
        rotation-x={-Math.PI / 2}
        position={[0, 0.015, 0]}
        receiveShadow
        onClick={(e) => {
          e.stopPropagation();
          onOpenMeeting();
        }}
        onPointerOver={() => (document.body.style.cursor = "pointer")}
        onPointerOut={() => (document.body.style.cursor = "auto")}
      >
        <circleGeometry args={[3.4, 48]} />
        <meshStandardMaterial color={active ? "#243955" : "#182231"} />
      </mesh>
      {/* glowing ring when meetings are open */}
      <mesh ref={glowRing} rotation-x={-Math.PI / 2} position={[0, 0.03, 0]} visible={false}>
        <torusGeometry args={[2.55, 0.055, 8, 64]} />
        <meshStandardMaterial color="#4cc9f0" emissive="#4cc9f0" emissiveIntensity={hasOpen ? 1.3 : 0.6} />
      </mesh>
      {/* round table pedestal */}
      <mesh position={[0, 0.42, 0]} castShadow>
        <cylinderGeometry args={[0.45, 0.72, 0.84, 24]} />
        <meshStandardMaterial color="#2c3340" metalness={0.3} roughness={0.6} />
      </mesh>
      {/* round table top */}
      <mesh
        position={[0, 0.86, 0]}
        castShadow
        receiveShadow
        onClick={(e) => {
          e.stopPropagation();
          onOpenMeeting();
        }}
        onPointerOver={() => (document.body.style.cursor = "pointer")}
        onPointerOut={() => (document.body.style.cursor = "auto")}
      >
        <cylinderGeometry args={[2.25, 2.25, 0.1, 48]} />
        <meshStandardMaterial color={hasOpen ? "#354a63" : "#2c3645"} metalness={0.2} roughness={0.5} />
      </mesh>
      {/* center hub puck */}
      <mesh position={[0, 0.94, 0]}>
        <cylinderGeometry args={[0.38, 0.42, 0.07, 24]} />
        <meshStandardMaterial
          color="#161b22"
          emissive={hasOpen ? "#4cc9f0" : "#4f9dff"}
          emissiveIntensity={hasOpen ? 1.1 : 0.25}
        />
      </mesh>
      {/* decorative chairs around the round table */}
      {[0, 1, 2, 3, 4, 5].map((i) => {
        const angle = (i * Math.PI * 2) / 6;
        const cx = Math.cos(angle) * 2.75;
        const cz = Math.sin(angle) * 2.75;
        return (
          <mesh key={i} position={[cx, 0.32, cz]} castShadow>
            <cylinderGeometry args={[0.26, 0.22, 0.56, 16]} />
            <meshStandardMaterial color="#222a36" />
          </mesh>
        );
      })}
      {/* table title */}
      <Html position={[0, 1.35, 0]} center distanceFactor={16} zIndexRange={[10, 0]}>
        <div
          className={`desk-label meeting ${active ? "selected" : ""} ${hasOpen ? "has-open" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpenMeeting();
          }}
        >
          <strong>Phòng họp</strong>
          <span>{hasOpen ? `${openConversations.length} cuộc họp đang mở` : "Chưa có cuộc họp mở"}</span>
        </div>
      </Html>

      {/* Open conversations: participant lines + speech bubbles */}
      {openConversations.map((conv, idx) => {
        const lineColor = CONV_LINE_COLORS[idx % CONV_LINE_COLORS.length];
        const latestMsg = latestMsgByConv.get(conv.id) ?? conv.lastMessage ?? null;
        const speakerId = latestMsg?.fromAgentId ?? null;
        const speakerName = speakerId ? seatsById.get(speakerId)?.name ?? speakerId : null;
        const bubbleAngle = (idx * Math.PI * 2) / Math.max(1, openConversations.length);
        const bubbleRadius = openConversations.length > 1 ? 1.45 : 0;
        const bubblePos: [number, number, number] = [
          Math.cos(bubbleAngle) * bubbleRadius,
          2.45 + (idx % 2) * 0.55,
          Math.sin(bubbleAngle) * bubbleRadius,
        ];

        return (
          <group key={conv.id}>
            {conv.participants.map((pid) => {
              const seat = seatsById.get(pid);
              if (!seat) return null;
              const isSpeaker = pid === speakerId;
              const start: [number, number, number] = [seat.position[0], 1.05, seat.position[2]];
              const mid: [number, number, number] = [
                seat.position[0] * 0.45,
                1.65 + (isSpeaker ? 0.25 : 0),
                seat.position[2] * 0.45,
              ];
              const end: [number, number, number] = [0, 0.96, 0];
              return (
                <Line
                  key={`${conv.id}-${pid}`}
                  points={[start, mid, end]}
                  color={isSpeaker ? "#ffd166" : lineColor}
                  lineWidth={isSpeaker ? 3.2 : 1.6}
                  transparent
                  opacity={isSpeaker ? 0.95 : 0.65}
                />
              );
            })}
            <Html position={bubblePos} center distanceFactor={16} zIndexRange={[15, 0]}>
              <button
                type="button"
                className="speech-bubble"
                style={{ borderColor: lineColor }}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenMeeting(conv.id);
                }}
              >
                <div className="speech-bubble-head">
                  <span className="chip">{CONVERSATION_TYPE_LABEL[conv.type]}</span>
                  <strong>{conv.title}</strong>
                </div>
                {latestMsg ? (
                  <div className="speech-bubble-body">
                    <span className="speech-speaker">{speakerName}:</span> {latestMsg.summary}
                  </div>
                ) : (
                  <div className="speech-bubble-body muted">Chưa có tin nhắn · {conv.participants.length} thành viên</div>
                )}
              </button>
            </Html>
          </group>
        );
      })}
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

function LibraryBookshelf({
  position,
  active,
  onOpen,
}: {
  position: [number, number, number];
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <group
      position={position}
      rotation={[0, -Math.PI / 6, 0]}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "auto")}
    >
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.015, 0]} receiveShadow>
        <circleGeometry args={[1.35, 36]} />
        <meshStandardMaterial color={active ? "#2a3b5c" : "#1b2636"} />
      </mesh>
      <mesh position={[0, 1.1, -0.22]} castShadow>
        <boxGeometry args={[1.8, 2.2, 0.06]} />
        <meshStandardMaterial color="#5b4330" />
      </mesh>
      {[-0.87, 0.87].map((x) => (
        <mesh key={x} position={[x, 1.1, 0]} castShadow>
          <boxGeometry args={[0.08, 2.2, 0.48]} />
          <meshStandardMaterial color="#75563d" />
        </mesh>
      ))}
      {[0.14, 0.74, 1.34, 1.94, 2.18].map((y) => (
        <mesh key={y} position={[0, y, 0]} castShadow>
          <boxGeometry args={[1.82, 0.07, 0.5]} />
          <meshStandardMaterial color="#8d6e52" />
        </mesh>
      ))}
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
      <Html position={[0, 2.55, 0]} center distanceFactor={16} zIndexRange={[10, 0]}>
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

function AccountsRack({
  active,
  slots,
  onOpen,
}: {
  active: boolean;
  slots: AccountSlot[];
  onOpen: () => void;
}) {
  const readyCount = slots.filter((s) => s.status === "ready").length;
  const lights = slots.slice(0, 12);

  return (
    <group
      position={[-3.4, 0, -11.6]}
      rotation={[0, Math.PI / 10, 0]}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "auto")}
    >
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.015, 0]} receiveShadow>
        <circleGeometry args={[1.35, 36]} />
        <meshStandardMaterial color={active ? "#2a3b5c" : "#1b2636"} />
      </mesh>
      <mesh position={[0, 1.1, 0]} castShadow>
        <boxGeometry args={[1.55, 2.2, 0.72]} />
        <meshStandardMaterial color="#1f2733" metalness={0.35} roughness={0.55} />
      </mesh>
      <mesh position={[0, 1.1, 0.35]}>
        <boxGeometry args={[1.35, 1.98, 0.04]} />
        <meshStandardMaterial color="#11161e" metalness={0.2} roughness={0.7} />
      </mesh>
      {[0.45, 0.85, 1.25, 1.65].map((y) => (
        <mesh key={y} position={[0, y, 0.38]}>
          <boxGeometry args={[1.28, 0.04, 0.03]} />
          <meshStandardMaterial color="#303846" />
        </mesh>
      ))}
      {lights.length > 0 ? (
        lights.map((slot, idx) => {
          const col = idx % 4;
          const row = Math.floor(idx / 4);
          const x = -0.42 + col * 0.28;
          const y = 1.82 - row * 0.4;
          const color = SLOT_STATUS_COLOR[slot.status];
          return (
            <mesh key={slot.id} position={[x, y, 0.4]}>
              <sphereGeometry args={[0.065, 14, 14]} />
              <meshStandardMaterial color={color} emissive={color} emissiveIntensity={active ? 1.8 : 1.1} />
            </mesh>
          );
        })
      ) : (
        <mesh position={[0, 1.82, 0.4]}>
          <sphereGeometry args={[0.065, 14, 14]} />
          <meshStandardMaterial color="#6e7681" emissive="#6e7681" emissiveIntensity={0.4} />
        </mesh>
      )}
      <Html position={[0, 2.55, 0]} center distanceFactor={16} zIndexRange={[10, 0]}>
        <div
          className={`desk-label accounts ${active ? "selected" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          <strong>Tài khoản &amp; Hạn mức</strong>
          <span>{slots.length > 0 ? `${readyCount}/${slots.length} sẵn sàng` : "Quản lý slot & quota"}</span>
        </div>
      </Html>
    </group>
  );
}

export default function Office3D({
  zones,
  seats,
  selectedId,
  onSelect,
  libraryOpen,
  onOpenLibrary,
  accountsOpen,
  onOpenAccounts,
  meetingOpen,
  onOpenMeeting,
  conversations,
  busMessages,
  accountSlots,
  paused,
}: {
  zones: DepartmentZone[];
  seats: Seat[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  libraryOpen: boolean;
  onOpenLibrary: () => void;
  accountsOpen: boolean;
  onOpenAccounts: () => void;
  meetingOpen: boolean;
  onOpenMeeting: (conversationId?: string) => void;
  conversations: Conversation[];
  busMessages: BusMessage[];
  accountSlots: AccountSlot[];
  paused: boolean;
}) {
  const openConversations = useMemo(
    () => conversations.filter((c) => c.status === "open"),
    [conversations]
  );

  const seatsById = useMemo(() => new Map(seats.map((s) => [s.id, s])), [seats]);

  const latestMsgByConv = useMemo(() => {
    const map = new Map<string, BusMessage>();
    for (const m of busMessages) {
      if (m.status !== "delivered" || !m.conversationId) continue;
      if (!map.has(m.conversationId)) map.set(m.conversationId, m);
    }
    return map;
  }, [busMessages]);

  const speakerIds = useMemo(() => {
    const set = new Set<string>();
    for (const conv of openConversations) {
      const msg = latestMsgByConv.get(conv.id) ?? conv.lastMessage;
      if (msg?.fromAgentId) set.add(msg.fromAgentId);
    }
    return set;
  }, [openConversations, latestMsgByConv]);

  // Place Library bookshelf right next to Cursor Hub AI's seat
  const libraryPosition = useMemo<[number, number, number]>(() => {
    const cursorSeat = seats.find((s) => s.id === "cursor-hub-ai");
    if (cursorSeat) {
      return [cursorSeat.position[0] + 2.35, 0, cursorSeat.position[2] - 0.5];
    }
    return [10.4, 0, -9.2];
  }, [seats]);

  return (
    <Canvas
      shadows
      dpr={[1, 1.5]}
      frameloop={paused ? "never" : "always"}
      camera={{ position: [0, 15.5, 19.5], fov: 45 }}
      onPointerMissed={() => onSelect(null)}
      gl={{ powerPreference: "low-power", antialias: true }}
    >
      <color attach="background" args={["#0d1117"]} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[10, 16, 8]} intensity={1.15} castShadow shadow-mapSize={[1024, 1024]} />
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[34, 32]} />
        <meshStandardMaterial color="#161b22" />
      </mesh>
      <gridHelper args={[34, 34, "#30363d", "#21262d"]} position={[0, 0.005, 0]} />

      {zones.map((z) => (
        <DepartmentZoneTile key={z.id} zone={z} />
      ))}

      <MeetingTable
        active={meetingOpen}
        openConversations={openConversations}
        seatsById={seatsById}
        latestMsgByConv={latestMsgByConv}
        onOpenMeeting={onOpenMeeting}
      />

      {seats.map((s) => (
        <Desk
          key={s.id}
          seat={s}
          selected={s.id === selectedId}
          speaking={speakerIds.has(s.id)}
          onSelect={onSelect}
        />
      ))}

      <LibraryBookshelf position={libraryPosition} active={libraryOpen} onOpen={onOpenLibrary} />
      <AccountsRack active={accountsOpen} slots={accountSlots} onOpen={onOpenAccounts} />

      <OrbitControls
        enablePan
        minDistance={7}
        maxDistance={36}
        maxPolarAngle={Math.PI / 2.15}
        target={[0, 0.5, 0]}
      />
    </Canvas>
  );
}
