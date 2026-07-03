// TUMBO — deterministic sumo-arena simulation core.
// Everything gameplay-related lives here, in C, compiled to WASM.
// JS only writes packed inputs and reads the state buffer, so lockstep
// peers stay bit-identical as long as they feed the same inputs.

#include <box3d/box3d.h>
#include <math.h>
#include <stdint.h>
#include <string.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define TUMBO_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define TUMBO_EXPORT
#endif

#define MAX_PLAYERS 8
#define MAX_PIECES 256
#define MAX_HAZARDS 2
#define LEVEL_COUNT 8

// Custom maps: JS writes a compact byte blob (see BuildCustomLevel for the
// format) and initializes with level == LEVEL_CUSTOM. The blob is part of the
// deterministic setup, so lockstep peers must load identical bytes.
#define LEVEL_CUSTOM 8
#define CUSTOM_DATA_MAX 1024

#define TICK_DT ( 1.0f / 60.0f )
#define SUBSTEPS 4

#define PIECE_STEP 1.5f
#define PIECE_HX 0.74f
#define PIECE_HY 0.4f
#define PIECE_HZ 0.74f

#define PLAYER_RADIUS 0.6f
#define MOVE_ACCEL 28.0f
#define AIR_CONTROL 0.45f
#define MAX_MOVE_SPEED 9.0f
#define DASH_SPEED 7.5f
#define DASH_COOLDOWN_TICKS 45
#define POWER_DASH_MULT 2.3f
#define JUMP_SPEED 7.0f
#define JUMP_COOLDOWN_TICKS 14
#define GROUND_RAY_REACH 0.85f
#define FALL_Y ( -8.0f )
#define PIECE_KILL_Y ( -30.0f )
#define WARNING_TICKS 72
#define MIN_STANDING_PIECES 3
#define COUNTDOWN_TICKS 180

// Feel: inputs pressed slightly early or late still count.
#define INPUT_BUFFER_TICKS 6
#define COYOTE_TICKS 6

// Brace: hold to anchor. Blocks your own actions, brakes hard, and blunts
// incoming dash hits. Brace started within the parry window reflects them.
#define BRACE_BRAKE_GAIN 8.0f
#define BRACE_HIT_FACTOR 0.35f
#define PARRY_WINDOW 8

// Dash-hit bonus: a recent dasher transfers extra knockback on contact.
#define DASH_HIT_WINDOW 10
#define DASH_HIT_KNOCKBACK 0.5f
#define HIT_EVENT_MIN_SPEED 3.0f

// Collision categories so the ground ray can ignore every player.
#define CAT_WORLD 1ull
#define CAT_PLAYER 2ull

// Input bits, one uint32 per player, written by the shell each tick.
#define IN_UP 1u
#define IN_DOWN 2u
#define IN_LEFT 4u
#define IN_RIGHT 8u
#define IN_DASH 16u
#define IN_JUMP 32u
#define IN_BRACE 64u

// State buffer layout (floats):
//   header[8]: frame, aliveMask, playerCount, pieceCount, winner, levelId, hazardCount, powerupActive
//   per player[8]:  x y z qx qy qz qw flags
//     flags: bit0 alive, bit1 dash ready, bit2 has power, bits3-8 dash cooldown ticks, bit9 braced
//   per piece[8]:   x y z qx qy qz qw state   (0 gone, 1 static, 2 falling, 3 warning)
//   per hazard[12]: x y z qx qy qz qw sx sy sz type reserved
//   powerup[4]:     x y z active
#define STATE_HEADER 8
#define STATE_STRIDE 8
#define HAZARD_STRIDE 12

#define FLAG_ALIVE 1
#define FLAG_DASH_READY 2
#define FLAG_HAS_POWER 4
#define FLAG_CD_SHIFT 3
#define FLAG_BRACED 512

enum
{
	PIECE_GONE = 0,
	PIECE_STATIC = 1,
	PIECE_FALLING = 2,
	PIECE_WARNING = 3,
};

enum
{
	LEVEL_CLASICA = 0,
	LEVEL_ANILLO = 1,
	LEVEL_PUENTES = 2,
	LEVEL_RULETA = 3,
	LEVEL_PIRAMIDE = 4,
	LEVEL_HERRADURA = 5,
	LEVEL_PASARELA = 6,
	LEVEL_TARIMAS = 7,
};

enum
{
	HAZARD_BEAM = 0,
	HAZARD_PISTON = 1,
};

// Gameplay events for the presentation layer (sound, particles, camera).
// Each event is 6 floats: [type, x, y, z, a, b]. Cleared every tick.
enum
{
	EVT_HIT = 0,		 // a = approach speed, b = player index (or -1)
	EVT_DASH = 1,		 // a = 1 if powered, b = player index
	EVT_JUMP = 2,		 // b = player index
	EVT_TILE_DROP = 3,	 // tile starts falling
	EVT_TILE_WARN = 4,	 // tile starts shaking
	EVT_FALL = 5,		 // b = eliminated player index
	EVT_ORB_SPAWN = 6,	 // a = 1 if knocked loose from a carrier
	EVT_ORB_PICKUP = 7,	 // b = player index
	EVT_ROUND_END = 8,	 // a = winner (-2 draw)
	EVT_DASH_HIT = 9,	 // a = attacker, b = victim
	EVT_PARRY = 10,		 // a = attacker (reflected), b = parrier
};

#define MAX_EVENTS 32
#define EVENT_FLOATS 6

typedef struct Player
{
	b3BodyId body;
	b3Vec3 facing;
	uint32_t prevIn;
	int dashCooldown;
	int jumpCooldown;
	int jumpBuffer;
	int dashBuffer;
	int coyote;
	int braceTicks;
	bool hasPower;
	bool alive;
} Player;

typedef struct Piece
{
	b3BodyId body;
	int state;
	int timer;	   // ticks left in WARNING before dropping
	int priority;  // crumble group, lower falls first
} Piece;

typedef struct Hazard
{
	b3BodyId body;
	b3Vec3 halfExtents;
	int type;
} Hazard;

typedef struct Powerup
{
	b3Vec3 pos;
	bool active;
	uint32_t nextEventTick;
} Powerup;

// Deterministic bot: reads sim state, writes its input word. Costs zero
// bytes on the wire — in lockstep both peers run the same bot code.
typedef struct Bot
{
	bool active;
	int difficulty; // 0 easy, 1 medium, 2 hard
	int think;
	float tx, tz;	 // steering target
	bool holdBrace;
	bool pulseDash;
	bool pulseJump;
} Bot;

static b3WorldId g_world;
static Player g_players[MAX_PLAYERS];
static Piece g_pieces[MAX_PIECES];
static Hazard g_hazards[MAX_HAZARDS];
static Bot g_bots[MAX_PLAYERS];
static Powerup g_powerup;
static int g_playerCount;
static int g_pieceCount;
static int g_hazardCount;
static int g_level;
static int g_crumbleOrder[MAX_PIECES];
static int g_crumbleNext;
static int g_standingPieces;
static uint32_t g_crumbleStart;
static uint32_t g_crumbleInterval;
static uint32_t g_frame;
static int g_winner; // -1 ongoing, -2 draw, else player index

static uint32_t g_inputs[MAX_PLAYERS];
static uint8_t g_customData[CUSTOM_DATA_MAX];
static int g_customLen;
static float g_customSpawns[MAX_PLAYERS][2];
static int g_customSpawnCount;
static float g_state[STATE_HEADER + STATE_STRIDE * ( MAX_PLAYERS + MAX_PIECES ) + HAZARD_STRIDE * MAX_HAZARDS + 4];
static float g_events[MAX_EVENTS * EVENT_FLOATS];
static int g_eventCount;

static void PushEvent( int type, float x, float y, float z, float a, float b )
{
	if ( g_eventCount >= MAX_EVENTS )
	{
		return;
	}
	float* e = g_events + g_eventCount * EVENT_FLOATS;
	e[0] = (float)type;
	e[1] = x;
	e[2] = y;
	e[3] = z;
	e[4] = a;
	e[5] = b;
	g_eventCount += 1;
}

// PCG32 — two independent deterministic streams: one for world decisions
// (crumble shuffle, orb placement), one for bot noise, so enabling bots
// never perturbs the level/orb stream.
static uint64_t g_rngState;
static uint64_t g_botRngState;

static uint32_t PcgNext( uint64_t* state )
{
	uint64_t old = *state;
	*state = old * 6364136223846793005ULL + 1442695040888963407ULL;
	uint32_t xorshifted = (uint32_t)( ( ( old >> 18u ) ^ old ) >> 27u );
	uint32_t rot = (uint32_t)( old >> 59u );
	return ( xorshifted >> rot ) | ( xorshifted << ( ( 32u - rot ) & 31u ) );
}

static uint32_t RngNext( void )
{
	return PcgNext( &g_rngState );
}

static uint32_t BotRng( void )
{
	return PcgNext( &g_botRngState );
}

TUMBO_EXPORT uint32_t* tumbo_inputs_ptr( void )
{
	return g_inputs;
}

TUMBO_EXPORT float* tumbo_state_ptr( void )
{
	return g_state;
}

TUMBO_EXPORT int tumbo_state_floats( void )
{
	return STATE_HEADER + STATE_STRIDE * ( g_playerCount + g_pieceCount ) + HAZARD_STRIDE * g_hazardCount + 4;
}

TUMBO_EXPORT int tumbo_level_count( void )
{
	return LEVEL_COUNT;
}

TUMBO_EXPORT float* tumbo_events_ptr( void )
{
	return g_events;
}

TUMBO_EXPORT int tumbo_event_count( void )
{
	return g_eventCount;
}

TUMBO_EXPORT int tumbo_countdown_ticks( void )
{
	return COUNTDOWN_TICKS;
}

TUMBO_EXPORT uint8_t* tumbo_custom_ptr( void )
{
	return g_customData;
}

TUMBO_EXPORT void tumbo_set_custom( int len )
{
	g_customLen = len < 0 ? 0 : ( len > CUSTOM_DATA_MAX ? CUSTOM_DATA_MAX : len );
}

// Enable a deterministic bot on a player slot. Call between tumbo_init and
// the first tumbo_step, identically on every lockstep peer.
TUMBO_EXPORT void tumbo_set_bot( int slot, int difficulty )
{
	if ( slot < 0 || slot >= g_playerCount )
	{
		return;
	}
	g_bots[slot].active = true;
	g_bots[slot].difficulty = difficulty < 0 ? 0 : ( difficulty > 2 ? 2 : difficulty );
	g_bots[slot].think = 0;
	g_bots[slot].tx = 0.0f;
	g_bots[slot].tz = 0.0f;
	g_bots[slot].holdBrace = false;
	g_bots[slot].pulseDash = false;
	g_bots[slot].pulseJump = false;
}

static void WriteState( void )
{
	g_state[0] = (float)g_frame;
	uint32_t aliveMask = 0;
	for ( int i = 0; i < g_playerCount; ++i )
	{
		if ( g_players[i].alive )
		{
			aliveMask |= 1u << i;
		}
	}
	g_state[1] = (float)aliveMask;
	g_state[2] = (float)g_playerCount;
	g_state[3] = (float)g_pieceCount;
	g_state[4] = (float)g_winner;
	g_state[5] = (float)g_level;
	g_state[6] = (float)g_hazardCount;
	g_state[7] = g_powerup.active ? 1.0f : 0.0f;

	float* out = g_state + STATE_HEADER;
	for ( int i = 0; i < g_playerCount; ++i )
	{
		Player* p = &g_players[i];
		b3Pos pos = b3Body_GetPosition( p->body );
		b3Quat q = b3Body_GetRotation( p->body );
		out[0] = pos.x;
		out[1] = pos.y;
		out[2] = pos.z;
		out[3] = q.v.x;
		out[4] = q.v.y;
		out[5] = q.v.z;
		out[6] = q.s;
		int cd = p->dashCooldown > 63 ? 63 : p->dashCooldown;
		int flags = ( p->alive ? FLAG_ALIVE : 0 ) | ( p->dashCooldown == 0 ? FLAG_DASH_READY : 0 ) |
					( p->hasPower ? FLAG_HAS_POWER : 0 ) | ( cd << FLAG_CD_SHIFT ) |
					( p->braceTicks > 0 ? FLAG_BRACED : 0 );
		out[7] = (float)flags;
		out += STATE_STRIDE;
	}
	for ( int i = 0; i < g_pieceCount; ++i )
	{
		b3Pos pos = b3Body_GetPosition( g_pieces[i].body );
		b3Quat q = b3Body_GetRotation( g_pieces[i].body );
		out[0] = pos.x;
		out[1] = pos.y;
		out[2] = pos.z;
		out[3] = q.v.x;
		out[4] = q.v.y;
		out[5] = q.v.z;
		out[6] = q.s;
		out[7] = (float)g_pieces[i].state;
		out += STATE_STRIDE;
	}
	for ( int i = 0; i < g_hazardCount; ++i )
	{
		b3Pos pos = b3Body_GetPosition( g_hazards[i].body );
		b3Quat q = b3Body_GetRotation( g_hazards[i].body );
		out[0] = pos.x;
		out[1] = pos.y;
		out[2] = pos.z;
		out[3] = q.v.x;
		out[4] = q.v.y;
		out[5] = q.v.z;
		out[6] = q.s;
		out[7] = g_hazards[i].halfExtents.x;
		out[8] = g_hazards[i].halfExtents.y;
		out[9] = g_hazards[i].halfExtents.z;
		out[10] = (float)g_hazards[i].type;
		out[11] = 0.0f;
		out += HAZARD_STRIDE;
	}
	out[0] = g_powerup.pos.x;
	out[1] = g_powerup.pos.y;
	out[2] = g_powerup.pos.z;
	out[3] = g_powerup.active ? 1.0f : 0.0f;
}

// ---------------------------------------------------------------------------
// Level construction
// ---------------------------------------------------------------------------

static void AddPiece( float cx, float cz, float topY, int priority, const b3BoxHull* hull )
{
	if ( g_pieceCount >= MAX_PIECES )
	{
		return;
	}

	b3BodyDef bodyDef = b3DefaultBodyDef();
	bodyDef.type = b3_staticBody;
	bodyDef.position = ( b3Pos ){ cx, topY - PIECE_HY, cz };
	b3BodyId body = b3CreateBody( g_world, &bodyDef );

	b3ShapeDef shapeDef = b3DefaultShapeDef();
	shapeDef.baseMaterial.friction = 0.7f;
	shapeDef.baseMaterial.restitution = 0.0f;
	shapeDef.density = 800.0f;
	shapeDef.filter.categoryBits = CAT_WORLD;
	b3CreateHullShape( body, &shapeDef, &hull->base );

	g_pieces[g_pieceCount].body = body;
	g_pieces[g_pieceCount].state = PIECE_STATIC;
	g_pieces[g_pieceCount].timer = 0;
	g_pieces[g_pieceCount].priority = priority;
	g_pieceCount += 1;
}

// Crumble order: ascending priority group, then farthest-from-origin first,
// then index. Insertion sort keeps it simple and deterministic.
static void SortCrumbleOrder( void )
{
	for ( int i = 0; i < g_pieceCount; ++i )
	{
		g_crumbleOrder[i] = i;
	}
	for ( int i = 1; i < g_pieceCount; ++i )
	{
		int key = g_crumbleOrder[i];
		b3Pos kp = b3Body_GetPosition( g_pieces[key].body );
		float kd = kp.x * kp.x + kp.z * kp.z;
		int kprio = g_pieces[key].priority;
		int j = i - 1;
		while ( j >= 0 )
		{
			int other = g_crumbleOrder[j];
			b3Pos jp = b3Body_GetPosition( g_pieces[other].body );
			float jd = jp.x * jp.x + jp.z * jp.z;
			int jprio = g_pieces[other].priority;
			if ( jprio < kprio || ( jprio == kprio && jd >= kd ) )
			{
				break;
			}
			g_crumbleOrder[j + 1] = other;
			j -= 1;
		}
		g_crumbleOrder[j + 1] = key;
	}
}

static void ShuffleCrumbleOrder( void )
{
	for ( int i = 0; i < g_pieceCount; ++i )
	{
		g_crumbleOrder[i] = i;
	}
	for ( int i = g_pieceCount - 1; i > 0; --i )
	{
		int j = (int)( RngNext() % (uint32_t)( i + 1 ) );
		int tmp = g_crumbleOrder[i];
		g_crumbleOrder[i] = g_crumbleOrder[j];
		g_crumbleOrder[j] = tmp;
	}
}

// Kinematic hazard. Created inert: StepHazards drives velocities only after
// the countdown, so nothing sweeps through frozen players at round start.
static void AddBoxHazard( b3Vec3 pos, b3Vec3 half, int type )
{
	if ( g_hazardCount >= MAX_HAZARDS )
	{
		return;
	}

	b3BodyDef bodyDef = b3DefaultBodyDef();
	bodyDef.type = b3_kinematicBody;
	bodyDef.position = ( b3Pos ){ pos.x, pos.y, pos.z };
	bodyDef.enableSleep = false;
	b3BodyId body = b3CreateBody( g_world, &bodyDef );

	b3BoxHull hull = b3MakeBoxHull( half.x, half.y, half.z );
	b3ShapeDef shapeDef = b3DefaultShapeDef();
	shapeDef.baseMaterial.friction = 0.2f;
	shapeDef.baseMaterial.restitution = 0.4f;
	shapeDef.density = 2000.0f;
	shapeDef.filter.categoryBits = CAT_WORLD;
	b3CreateHullShape( body, &shapeDef, &hull.base );

	g_hazards[g_hazardCount].body = body;
	g_hazards[g_hazardCount].halfExtents = half;
	g_hazards[g_hazardCount].type = type;
	g_hazardCount += 1;
}

static void BuildLevel( int level, const b3BoxHull* hull )
{
	int extent = 7;
	for ( int gx = -extent; gx <= extent; ++gx )
	{
		for ( int gz = -extent; gz <= extent; ++gz )
		{
			float cx = gx * PIECE_STEP;
			float cz = gz * PIECE_STEP;
			float d2 = cx * cx + cz * cz;

			if ( level == LEVEL_CLASICA )
			{
				if ( d2 <= 8.4f * 8.4f )
				{
					AddPiece( cx, cz, 0.0f, 0, hull );
				}
			}
			else if ( level == LEVEL_ANILLO )
			{
				if ( d2 <= 10.1f * 10.1f && d2 >= 4.06f * 4.06f )
				{
					AddPiece( cx, cz, 0.0f, 0, hull );
				}
			}
			else if ( level == LEVEL_PUENTES )
			{
				float dc2[4];
				dc2[0] = ( cx - 8.4f ) * ( cx - 8.4f ) + cz * cz;
				dc2[1] = ( cx + 8.4f ) * ( cx + 8.4f ) + cz * cz;
				dc2[2] = cx * cx + ( cz - 8.4f ) * ( cz - 8.4f );
				dc2[3] = cx * cx + ( cz + 8.4f ) * ( cz + 8.4f );
				float islandR2 = 2.8f * 2.8f;
				bool inIsland = dc2[0] <= islandR2 || dc2[1] <= islandR2 || dc2[2] <= islandR2 || dc2[3] <= islandR2;
				bool inCenter = d2 <= 3.22f * 3.22f;
				bool onBridge = ( gz == 0 || gx == 0 ) && d2 <= 8.4f * 8.4f;

				if ( inCenter )
				{
					AddPiece( cx, cz, 0.0f, d2 > 1.96f * 1.96f ? 3 : 4, hull );
				}
				else if ( inIsland )
				{
					float best = dc2[0];
					for ( int k = 1; k < 4; ++k )
					{
						if ( dc2[k] < best )
						{
							best = dc2[k];
						}
					}
					AddPiece( cx, cz, 0.0f, best > 1.82f * 1.82f ? 1 : 2, hull );
				}
				else if ( onBridge )
				{
					AddPiece( cx, cz, 0.0f, 0, hull );
				}
			}
			else if ( level == LEVEL_RULETA )
			{
				if ( d2 <= 9.1f * 9.1f )
				{
					AddPiece( cx, cz, 0.0f, 0, hull );
				}
			}
			else if ( level == LEVEL_PIRAMIDE )
			{
				// Three concentric square terraces; king of the hill.
				int ax = gx < 0 ? -gx : gx;
				int az = gz < 0 ? -gz : gz;
				int m = ax > az ? ax : az;
				if ( m <= 6 )
				{
					float h = m <= 2 ? 1.6f : ( m <= 4 ? 0.8f : 0.0f );
					int prio = m >= 5 ? 0 : ( m >= 3 ? 1 : 2 );
					AddPiece( cx, cz, h, prio, hull );
				}
			}
			else if ( level == LEVEL_HERRADURA )
			{
				// Ring with an opening at -Z; the collapse wave sweeps from
				// one horn of the U to the other. Push rivals INTO the wave.
				if ( d2 <= 10.36f * 10.36f && d2 >= 4.2f * 4.2f && !( cz < -2.8f && ( cx < 3.22f && cx > -3.22f ) ) )
				{
					float rel = fmodf( atan2f( cz, cx ) + 3.14159265f * 0.5f + 6.2831853f, 6.2831853f );
					AddPiece( cx, cz, 0.0f, (int)( rel * 10.0f ), hull );
				}
			}
			else if ( level == LEVEL_PASARELA )
			{
				// 1D corridor duel with dodge alcoves; collapses inward from
				// both ends while pistons sweep the lane.
				int ax = gx < 0 ? -gx : gx;
				int az = gz < 0 ? -gz : gz;
				bool corridor = ax <= 7 && az <= 1;
				bool alcove = ax == 4 && az == 2;
				if ( corridor || alcove )
				{
					AddPiece( cx, cz, 0.0f, 7 - ax, hull );
				}
			}
			else // LEVEL_TARIMAS
			{
				// Archipelago of pads split by exactly one-tile gaps; pads
				// sink in a fixed, learnable order. Central plaza dies last.
				int prio = -1;
				float h = 0.0f;
				if ( gx >= -2 && gx <= 2 && gz >= -2 && gz <= 2 )
				{
					prio = 5;
				}
				else if ( gx >= 4 && gx <= 6 && gz >= -1 && gz <= 1 )
				{
					prio = 0;
					h = 0.8f;
				}
				else if ( gx >= -6 && gx <= -4 && gz >= -1 && gz <= 1 )
				{
					prio = 1;
					h = 0.8f;
				}
				else if ( gx >= -1 && gx <= 1 && gz >= 4 && gz <= 6 )
				{
					prio = 2;
				}
				else if ( gx >= -1 && gx <= 1 && gz >= -6 && gz <= -4 )
				{
					prio = 3;
				}
				else if ( gx >= 4 && gx <= 6 && gz >= 4 && gz <= 6 )
				{
					prio = 4;
					h = 0.8f;
				}
				if ( prio >= 0 )
				{
					AddPiece( cx, cz, h, prio, hull );
				}
			}
		}
	}

	switch ( level )
	{
		case LEVEL_RULETA:
			ShuffleCrumbleOrder();
			AddBoxHazard( ( b3Vec3 ){ 0.0f, 0.95f, 0.0f }, ( b3Vec3 ){ 8.1f, 0.3f, 0.32f }, HAZARD_BEAM );
			g_crumbleStart = 420;
			g_crumbleInterval = 20;
			break;
		case LEVEL_PIRAMIDE:
			SortCrumbleOrder();
			g_crumbleStart = 600;
			g_crumbleInterval = 18;
			break;
		case LEVEL_HERRADURA:
			SortCrumbleOrder();
			g_crumbleStart = 480;
			g_crumbleInterval = 15;
			break;
		case LEVEL_PASARELA:
			SortCrumbleOrder();
			AddBoxHazard( ( b3Vec3 ){ -3.0f, 0.5f, -2.6f }, ( b3Vec3 ){ 0.5f, 0.5f, 0.75f }, HAZARD_PISTON );
			AddBoxHazard( ( b3Vec3 ){ 3.0f, 0.5f, 2.6f }, ( b3Vec3 ){ 0.5f, 0.5f, 0.75f }, HAZARD_PISTON );
			g_crumbleStart = 540;
			g_crumbleInterval = 28;
			break;
		case LEVEL_TARIMAS:
			SortCrumbleOrder();
			g_crumbleStart = 540;
			g_crumbleInterval = 21;
			break;
		case LEVEL_PUENTES:
			SortCrumbleOrder();
			g_crumbleStart = 480;
			g_crumbleInterval = 24;
			break;
		default:
			SortCrumbleOrder();
			g_crumbleStart = 600;
			g_crumbleInterval = 28;
			break;
	}
}

// Custom map blob layout (little-endian bytes):
//   [0] version (must be 1)     [1] theme id (presentation only)
//   [2] crumble start, in 10-tick units (clamped to >= countdown + 60)
//   [3] crumble interval, ticks (clamped to >= 6)
//   [4] tile count              [5] spawn count (max 8)
//   [6] beam half-length, 0.1m units (0 = no beam)
//   [7] reserved
//   then per tile 3 bytes:  gx+16, gz+16, low 2 bits height (0 / 0.8 / 1.6m),
//                           high 4 bits crumble priority
//   then per spawn 2 bytes: gx+16, gz+16
static void BuildCustomLevel( const b3BoxHull* hull )
{
	const uint8_t* d = g_customData;
	g_customSpawnCount = 0;

	int tileCount = d[4];
	int spawnCount = d[5];
	int need = 8 + tileCount * 3 + spawnCount * 2;
	if ( g_customLen < 8 || d[0] != 1 || tileCount == 0 || g_customLen < need )
	{
		// Invalid blob: fall back to a plain disc so the game never breaks.
		BuildLevel( LEVEL_CLASICA, hull );
		return;
	}

	static const float heights[4] = { 0.0f, 0.8f, 1.6f, 1.6f };
	for ( int i = 0; i < tileCount && g_pieceCount < MAX_PIECES; ++i )
	{
		const uint8_t* t = d + 8 + i * 3;
		float cx = ( (int)t[0] - 16 ) * PIECE_STEP;
		float cz = ( (int)t[1] - 16 ) * PIECE_STEP;
		AddPiece( cx, cz, heights[t[2] & 3], ( t[2] >> 4 ) & 15, hull );
	}

	for ( int i = 0; i < spawnCount && i < MAX_PLAYERS; ++i )
	{
		const uint8_t* s = d + 8 + tileCount * 3 + i * 2;
		g_customSpawns[i][0] = ( (int)s[0] - 16 ) * PIECE_STEP;
		g_customSpawns[i][1] = ( (int)s[1] - 16 ) * PIECE_STEP;
		g_customSpawnCount += 1;
	}

	if ( d[6] > 0 )
	{
		AddBoxHazard( ( b3Vec3 ){ 0.0f, 0.95f, 0.0f }, ( b3Vec3 ){ (float)d[6] * 0.1f, 0.3f, 0.32f }, HAZARD_BEAM );
	}

	SortCrumbleOrder();
	uint32_t start = (uint32_t)d[2] * 10u;
	g_crumbleStart = start < COUNTDOWN_TICKS + 60u ? COUNTDOWN_TICKS + 60u : start;
	g_crumbleInterval = d[3] < 6 ? 6 : d[3];
}

// Top surface height of the tile at (x, z), or 0 when there is none.
static float TileTopAt( float x, float z )
{
	for ( int i = 0; i < g_pieceCount; ++i )
	{
		b3Pos tp = b3Body_GetPosition( g_pieces[i].body );
		float dx = x - tp.x;
		float dz = z - tp.z;
		if ( dx > -0.76f && dx < 0.76f && dz > -0.76f && dz < 0.76f )
		{
			return tp.y + PIECE_HY;
		}
	}
	return 0.0f;
}

static void SpawnPoint( int level, int index, float* outX, float* outY, float* outZ )
{
	static const float dirs[MAX_PLAYERS][2] = {
		{ 1.0f, 0.0f },	  { -1.0f, 0.0f },		{ 0.0f, 1.0f },		  { 0.0f, -1.0f },
		{ 0.7071f, 0.7071f }, { -0.7071f, -0.7071f }, { 0.7071f, -0.7071f }, { -0.7071f, 0.7071f },
	};

	*outY = 0.0f;

	if ( level == LEVEL_CUSTOM && g_customSpawnCount > 0 )
	{
		int slot = index % g_customSpawnCount;
		// Repeated spawns get a small deterministic offset so players pop apart.
		float nudge = 0.35f * (float)( index / g_customSpawnCount );
		*outX = g_customSpawns[slot][0] + nudge;
		*outZ = g_customSpawns[slot][1];
		*outY = TileTopAt( g_customSpawns[slot][0], g_customSpawns[slot][1] );
		return;
	}

	if ( level == LEVEL_PUENTES )
	{
		// First four on the island centers, extras on the center plaza.
		if ( index < 4 )
		{
			*outX = 8.4f * dirs[index][0];
			*outZ = 8.4f * dirs[index][1];
		}
		else
		{
			*outX = 2.1f * dirs[index][0];
			*outZ = 2.1f * dirs[index][1];
		}
		return;
	}

	if ( level == LEVEL_PIRAMIDE )
	{
		// Corners of the low ring, then edge midpoints.
		static const float corners[MAX_PLAYERS][2] = {
			{ 1.0f, 1.0f }, { -1.0f, -1.0f }, { 1.0f, -1.0f }, { -1.0f, 1.0f },
			{ 1.0f, 0.0f }, { -1.0f, 0.0f },  { 0.0f, 1.0f },	{ 0.0f, -1.0f },
		};
		*outX = 9.0f * corners[index][0];
		*outZ = 9.0f * corners[index][1];
		return;
	}

	if ( level == LEVEL_HERRADURA )
	{
		// Around the U, never inside the opening (which faces -Z).
		static const float ring[MAX_PLAYERS][2] = {
			{ 1.0f, 0.0f },		  { -1.0f, 0.0f },		 { 0.0f, 1.0f },	   { 0.7071f, -0.7071f },
			{ -0.7071f, -0.7071f }, { 0.7071f, 0.7071f }, { -0.7071f, 0.7071f }, { 0.3827f, 0.9239f },
		};
		*outX = 7.28f * ring[index][0];
		*outZ = 7.28f * ring[index][1];
		return;
	}

	if ( level == LEVEL_PASARELA )
	{
		static const float lane[MAX_PLAYERS][2] = {
			{ 9.0f, 0.0f }, { -9.0f, 0.0f }, { 6.0f, 1.5f }, { -6.0f, -1.5f },
			{ 3.0f, -1.5f }, { -3.0f, 1.5f }, { 1.5f, 1.5f }, { -1.5f, -1.5f },
		};
		*outX = lane[index][0];
		*outZ = lane[index][1];
		return;
	}

	if ( level == LEVEL_TARIMAS )
	{
		// Outer pads first (their tops sit at 0.8 or 0), plaza corners after.
		static const float pads[MAX_PLAYERS][3] = {
			{ 7.5f, 0.8f, 0.0f }, { -7.5f, 0.8f, 0.0f }, { 0.0f, 0.0f, 7.5f }, { 0.0f, 0.0f, -7.5f },
			{ 7.5f, 0.8f, 7.5f }, { 1.5f, 0.0f, 1.5f },  { -1.5f, 0.0f, -1.5f }, { 1.5f, 0.0f, -1.5f },
		};
		*outX = pads[index][0];
		*outY = pads[index][1];
		*outZ = pads[index][2];
		return;
	}

	// Ruleta spawns on diagonals so the beam (along +X) misses at tick 0.
	int slot = level == LEVEL_RULETA ? ( index + 4 ) % MAX_PLAYERS : index;
	float radius = level == LEVEL_ANILLO ? 7.07f : ( level == LEVEL_RULETA ? 5.6f : 4.9f );
	*outX = radius * dirs[slot][0];
	*outZ = radius * dirs[slot][1];
}

TUMBO_EXPORT void tumbo_init( uint32_t seed, int playerCount, int level )
{
	if ( b3World_IsValid( g_world ) )
	{
		b3DestroyWorld( g_world );
	}

	g_rngState = ( (uint64_t)seed << 1u ) | 1u;
	g_botRngState = ( ( (uint64_t)seed ^ 0xB07B07ull ) << 1u ) | 1u;
	g_frame = 0;
	g_winner = -1;
	g_crumbleNext = 0;
	g_pieceCount = 0;
	g_hazardCount = 0;
	g_level = level < 0 ? 0 : ( level > LEVEL_CUSTOM ? LEVEL_CUSTOM : level );
	if ( g_level == LEVEL_CUSTOM && g_customLen < 8 )
	{
		g_level = 0;
	}
	g_playerCount = playerCount < 1 ? 1 : ( playerCount > MAX_PLAYERS ? MAX_PLAYERS : playerCount );
	g_powerup.active = false;
	g_powerup.pos = ( b3Vec3 ){ 0.0f, -100.0f, 0.0f };
	g_powerup.nextEventTick = 240;
	memset( g_inputs, 0, sizeof( g_inputs ) );
	memset( g_bots, 0, sizeof( g_bots ) );

	b3WorldDef worldDef = b3DefaultWorldDef();
	worldDef.gravity = ( b3Vec3 ){ 0.0f, -14.0f, 0.0f };
	worldDef.workerCount = 1;
	g_world = b3CreateWorld( &worldDef );

	b3BoxHull tileHull = b3MakeBoxHull( PIECE_HX, PIECE_HY, PIECE_HZ );
	if ( g_level == LEVEL_CUSTOM )
	{
		BuildCustomLevel( &tileHull );
	}
	else
	{
		BuildLevel( g_level, &tileHull );
	}
	g_standingPieces = g_pieceCount;

	for ( int i = 0; i < g_playerCount; ++i )
	{
		float sx, sy, sz;
		SpawnPoint( g_level, i, &sx, &sy, &sz );

		b3BodyDef bodyDef = b3DefaultBodyDef();
		bodyDef.type = b3_dynamicBody;
		bodyDef.position = ( b3Pos ){ sx, sy + PLAYER_RADIUS + 0.05f, sz };
		bodyDef.linearDamping = 0.4f;
		bodyDef.angularDamping = 0.8f;
		bodyDef.enableSleep = false;
		// Player index + 1, so hit events can identify players (0 = not a player).
		bodyDef.userData = (void*)(intptr_t)( i + 1 );
		b3BodyId body = b3CreateBody( g_world, &bodyDef );

		b3ShapeDef shapeDef = b3DefaultShapeDef();
		shapeDef.density = 1000.0f;
		shapeDef.baseMaterial.friction = 0.4f;
		shapeDef.baseMaterial.restitution = 0.55f;
		shapeDef.baseMaterial.rollingResistance = 0.03f;
		shapeDef.filter.categoryBits = CAT_PLAYER;
		shapeDef.enableHitEvents = true;
		b3Sphere sphere = { { 0.0f, 0.0f, 0.0f }, PLAYER_RADIUS };
		b3CreateSphereShape( body, &shapeDef, &sphere );

		// Face the center.
		float len = sx * sx + sz * sz;
		g_players[i].facing = len > 0.001f ? ( b3Vec3 ){ -sx, 0.0f, -sz } : ( b3Vec3 ){ 0.0f, 0.0f, -1.0f };
		g_players[i].body = body;
		g_players[i].prevIn = 0;
		g_players[i].dashCooldown = 0;
		g_players[i].jumpCooldown = 0;
		g_players[i].jumpBuffer = 0;
		g_players[i].dashBuffer = 0;
		g_players[i].coyote = 0;
		g_players[i].braceTicks = 0;
		g_players[i].hasPower = false;
		g_players[i].alive = true;
	}

	WriteState();
}

// ---------------------------------------------------------------------------
// Per-tick systems
// ---------------------------------------------------------------------------

static bool IsGrounded( const Player* p )
{
	b3Pos origin = b3Body_GetPosition( p->body );
	b3Vec3 translation = { 0.0f, -GROUND_RAY_REACH, 0.0f };
	b3QueryFilter filter = b3DefaultQueryFilter();
	filter.maskBits = CAT_WORLD;
	b3RayResult result = b3World_CastRayClosest( g_world, origin, translation, filter );
	return result.hit;
}

// 2 = standing on solid ground here, 1 = tile is about to drop, 0 = nothing.
static int SupportStateAt( float x, float z )
{
	int best = 0;
	for ( int i = 0; i < g_pieceCount; ++i )
	{
		if ( g_pieces[i].state != PIECE_STATIC && g_pieces[i].state != PIECE_WARNING )
		{
			continue;
		}
		b3Pos tp = b3Body_GetPosition( g_pieces[i].body );
		float dx = x - tp.x;
		float dz = z - tp.z;
		if ( dx > -0.78f && dx < 0.78f && dz > -0.78f && dz < 0.78f )
		{
			int s = g_pieces[i].state == PIECE_STATIC ? 2 : 1;
			if ( s > best )
			{
				best = s;
			}
		}
	}
	return best;
}

static void NearestSafeTile( float x, float z, float* outX, float* outZ )
{
	// Bias toward the centroid of remaining solid ground so bots retreat
	// inward instead of hugging a doomed rim.
	float cx = 0.0f, cz = 0.0f;
	int n = 0;
	for ( int i = 0; i < g_pieceCount; ++i )
	{
		if ( g_pieces[i].state == PIECE_STATIC )
		{
			b3Pos tp = b3Body_GetPosition( g_pieces[i].body );
			cx += tp.x;
			cz += tp.z;
			n += 1;
		}
	}
	if ( n == 0 )
	{
		*outX = 0.0f;
		*outZ = 0.0f;
		return;
	}
	cx /= (float)n;
	cz /= (float)n;

	float bestScore = 1e30f;
	for ( int i = 0; i < g_pieceCount; ++i )
	{
		if ( g_pieces[i].state != PIECE_STATIC )
		{
			continue;
		}
		b3Pos tp = b3Body_GetPosition( g_pieces[i].body );
		float dx = tp.x - x;
		float dz = tp.z - z;
		float ex = tp.x - cx;
		float ez = tp.z - cz;
		float score = dx * dx + dz * dz + 0.25f * ( ex * ex + ez * ez );
		if ( score < bestScore )
		{
			bestScore = score;
			*outX = tp.x;
			*outZ = tp.z;
		}
	}
}

static float WrapAngle( float a )
{
	while ( a > 3.14159265f )
	{
		a -= 6.2831853f;
	}
	while ( a < -3.14159265f )
	{
		a += 6.2831853f;
	}
	return a;
}

static void BotReplan( int slot )
{
	Bot* bot = &g_bots[slot];
	Player* p = &g_players[slot];
	b3Pos pos = b3Body_GetPosition( p->body );

	bot->holdBrace = false;
	bot->pulseDash = false;
	bot->pulseJump = false;

	// Priority 1: don't be standing on doomed ground.
	if ( SupportStateAt( pos.x, pos.z ) < 2 )
	{
		NearestSafeTile( pos.x, pos.z, &bot->tx, &bot->tz );
		if ( bot->difficulty >= 1 && p->jumpCooldown == 0 )
		{
			bot->pulseJump = true;
		}
		return;
	}

	// Priority 2: grab the orb when it's close and uncontested-ish.
	if ( g_powerup.active && !p->hasPower )
	{
		float ox = g_powerup.pos.x - pos.x;
		float oz = g_powerup.pos.z - pos.z;
		if ( ox * ox + oz * oz < 4.5f * 4.5f && ( BotRng() & 3u ) != 0u )
		{
			bot->tx = g_powerup.pos.x;
			bot->tz = g_powerup.pos.z;
			return;
		}
	}

	// Priority 3: hunt the nearest living rival.
	int target = -1;
	float bestD2 = 1e30f;
	for ( int j = 0; j < g_playerCount; ++j )
	{
		if ( j == slot || !g_players[j].alive )
		{
			continue;
		}
		b3Pos op = b3Body_GetPosition( g_players[j].body );
		float dx = op.x - pos.x;
		float dz = op.z - pos.z;
		float d2 = dx * dx + dz * dz;
		if ( d2 < bestD2 )
		{
			bestD2 = d2;
			target = j;
		}
	}
	if ( target < 0 )
	{
		bot->tx = 0.0f;
		bot->tz = 0.0f;
		return;
	}

	b3Pos op = b3Body_GetPosition( g_players[target].body );
	bot->tx = op.x;
	bot->tz = op.z;

	float dist = sqrtf( bestD2 );

	// Dash when close, roughly at the rival, and the shove would carry them
	// past solid ground (or just aggressively, on hard).
	if ( p->dashCooldown == 0 && dist < 2.4f && dist > 0.01f )
	{
		float dirx = ( op.x - pos.x ) / dist;
		float dirz = ( op.z - pos.z ) / dist;
		int landing = SupportStateAt( op.x + dirx * 2.2f, op.z + dirz * 2.2f );
		bool aggressive = bot->difficulty == 2 || ( BotRng() & 1u ) == 0u;
		if ( landing == 0 || aggressive )
		{
			bot->pulseDash = true;
		}
	}

	// Brace if the rival just dashed at us (medium+).
	if ( bot->difficulty >= 1 && dist < 3.2f &&
		 g_players[target].dashCooldown > DASH_COOLDOWN_TICKS - DASH_HIT_WINDOW )
	{
		bot->holdBrace = true;
		bot->pulseDash = false;
	}

	// Dodge a spinning beam: jump when an arm is about to sweep through.
	if ( g_hazardCount > 0 && g_hazards[0].type == HAZARD_BEAM && p->jumpCooldown == 0 )
	{
		b3Quat q = b3Body_GetRotation( g_hazards[0].body );
		float yaw = 2.0f * atan2f( q.v.y, q.s );
		float mine = atan2f( pos.z, pos.x );
		float d1 = WrapAngle( mine - yaw );
		float d2 = WrapAngle( mine - yaw - 3.14159265f );
		float d = fabsf( d1 ) < fabsf( d2 ) ? fabsf( d1 ) : fabsf( d2 );
		if ( d < 0.55f )
		{
			bot->pulseJump = true;
		}
	}
}

static void StepBots( void )
{
	if ( g_frame < COUNTDOWN_TICKS )
	{
		return;
	}

	// Noise/interval tuning per difficulty: easy is sloppy, hard is sharp.
	static const int thinkBase[3] = { 16, 11, 8 };
	static const int thinkJitter[3] = { 7, 5, 3 };
	static const float aimNoise[3] = { 0.6f, 0.25f, 0.08f };

	for ( int i = 0; i < g_playerCount; ++i )
	{
		Bot* bot = &g_bots[i];
		if ( !bot->active || !g_players[i].alive )
		{
			continue;
		}

		bot->think -= 1;
		if ( bot->think <= 0 )
		{
			BotReplan( i );
			int d = bot->difficulty;
			bot->think = thinkBase[d] + (int)( BotRng() % (uint32_t)( thinkJitter[d] + 1 ) );
		}

		b3Pos pos = b3Body_GetPosition( g_players[i].body );
		float dx = bot->tx - pos.x;
		float dz = bot->tz - pos.z;
		float len = sqrtf( dx * dx + dz * dz );

		uint32_t word = 0;
		if ( len > 0.35f )
		{
			dx /= len;
			dz /= len;
			// Aim noise: rotate the steering vector a touch.
			float noise = aimNoise[bot->difficulty];
			float a = ( (float)( BotRng() % 1000u ) / 1000.0f - 0.5f ) * 2.0f * noise;
			float ca = cosf( a );
			float sa = sinf( a );
			float rx = dx * ca - dz * sa;
			float rz = dx * sa + dz * ca;
			if ( rz < -0.38f )
			{
				word |= IN_UP;
			}
			if ( rz > 0.38f )
			{
				word |= IN_DOWN;
			}
			if ( rx < -0.38f )
			{
				word |= IN_LEFT;
			}
			if ( rx > 0.38f )
			{
				word |= IN_RIGHT;
			}
		}
		if ( bot->holdBrace )
		{
			word = IN_BRACE;
		}
		if ( bot->pulseDash )
		{
			word |= IN_DASH;
			bot->pulseDash = false;
		}
		if ( bot->pulseJump )
		{
			word |= IN_JUMP;
			bot->pulseJump = false;
		}
		g_inputs[i] = word;
	}
}

static void StepPlayers( void )
{
	// Inputs are frozen during the round-start countdown.
	bool frozen = g_frame < COUNTDOWN_TICKS;

	for ( int i = 0; i < g_playerCount; ++i )
	{
		Player* p = &g_players[i];
		if ( !p->alive )
		{
			continue;
		}

		uint32_t in = frozen ? 0u : g_inputs[i];
		uint32_t pressed = in & ~p->prevIn;
		p->prevIn = in;

		float mass = b3Body_GetMass( p->body );
		bool grounded = IsGrounded( p );

		// Timers: cooldowns, buffered presses, coyote time.
		if ( p->dashCooldown > 0 )
		{
			p->dashCooldown -= 1;
		}
		if ( p->jumpCooldown > 0 )
		{
			p->jumpCooldown -= 1;
		}
		if ( p->jumpBuffer > 0 )
		{
			p->jumpBuffer -= 1;
		}
		if ( p->dashBuffer > 0 )
		{
			p->dashBuffer -= 1;
		}
		if ( pressed & IN_JUMP )
		{
			p->jumpBuffer = INPUT_BUFFER_TICKS;
		}
		if ( pressed & IN_DASH )
		{
			p->dashBuffer = INPUT_BUFFER_TICKS;
		}
		p->coyote = grounded ? COYOTE_TICKS : ( p->coyote > 0 ? p->coyote - 1 : 0 );

		// Brace: anchor in place. No moving, dashing or jumping while held.
		bool bracing = ( in & IN_BRACE ) != 0 && grounded;
		if ( bracing )
		{
			p->braceTicks = p->braceTicks < 1000 ? p->braceTicks + 1 : 1000;
			b3Vec3 v = b3Body_GetLinearVelocity( p->body );
			b3Vec3 brake = { -v.x * BRACE_BRAKE_GAIN * mass, 0.0f, -v.z * BRACE_BRAKE_GAIN * mass };
			b3Body_ApplyForceToCenter( p->body, brake, true );
			continue;
		}
		p->braceTicks = 0;

		float dx = ( ( in & IN_RIGHT ) ? 1.0f : 0.0f ) - ( ( in & IN_LEFT ) ? 1.0f : 0.0f );
		float dz = ( ( in & IN_DOWN ) ? 1.0f : 0.0f ) - ( ( in & IN_UP ) ? 1.0f : 0.0f );
		if ( dx != 0.0f && dz != 0.0f )
		{
			dx *= 0.7071f;
			dz *= 0.7071f;
		}

		if ( dx != 0.0f || dz != 0.0f )
		{
			p->facing = ( b3Vec3 ){ dx, 0.0f, dz };
			b3Vec3 v = b3Body_GetLinearVelocity( p->body );
			// Only push while below max speed along the input direction.
			if ( v.x * dx + v.z * dz < MAX_MOVE_SPEED )
			{
				float accel = MOVE_ACCEL * ( grounded ? 1.0f : AIR_CONTROL );
				b3Vec3 force = { accel * mass * dx, 0.0f, accel * mass * dz };
				b3Body_ApplyForceToCenter( p->body, force, true );
			}
		}

		// Jump: buffered press + coyote window instead of exact-tick timing.
		if ( p->jumpBuffer > 0 && p->coyote > 0 && p->jumpCooldown == 0 )
		{
			b3Vec3 v = b3Body_GetLinearVelocity( p->body );
			if ( v.y <= 3.0f )
			{
				b3Vec3 impulse = { 0.0f, JUMP_SPEED * mass, 0.0f };
				b3Body_ApplyLinearImpulseToCenter( p->body, impulse, true );
				p->jumpCooldown = JUMP_COOLDOWN_TICKS;
				p->jumpBuffer = 0;
				p->coyote = 0;
				b3Pos pos = b3Body_GetPosition( p->body );
				PushEvent( EVT_JUMP, pos.x, pos.y, pos.z, 0.0f, (float)i );
			}
		}

		// Dash: buffered press fires the moment cooldown ends.
		if ( p->dashBuffer > 0 && p->dashCooldown == 0 )
		{
			bool powered = p->hasPower;
			float mult = powered ? POWER_DASH_MULT : 1.0f;
			p->hasPower = false;
			b3Vec3 impulse = { DASH_SPEED * mult * mass * p->facing.x, 0.0f, DASH_SPEED * mult * mass * p->facing.z };
			b3Body_ApplyLinearImpulseToCenter( p->body, impulse, true );
			p->dashCooldown = DASH_COOLDOWN_TICKS;
			p->dashBuffer = 0;
			b3Pos pos = b3Body_GetPosition( p->body );
			PushEvent( EVT_DASH, pos.x, pos.y, pos.z, powered ? 1.0f : 0.0f, (float)i );
		}
	}
}

static int PlayerIndexFromShape( b3ShapeId shapeId )
{
	void* userData = b3Body_GetUserData( b3Shape_GetBody( shapeId ) );
	return (int)(intptr_t)userData - 1;
}

// Apply the dash-hit interaction from `att` onto `vic` along `nx,nz`
// (already pointing attacker -> victim).
static void ResolveDashHit( int att, int vic, float nx, float nz, float speed, b3Pos point )
{
	Player* victim = &g_players[vic];
	if ( !victim->alive )
	{
		return;
	}

	// Parry: brace started within the window bounces the hit back.
	if ( victim->braceTicks > 0 && victim->braceTicks <= PARRY_WINDOW )
	{
		Player* attacker = &g_players[att];
		float mass = b3Body_GetMass( attacker->body );
		float k = DASH_HIT_KNOCKBACK * speed * mass;
		b3Vec3 impulse = { -nx * k, 0.3f * k, -nz * k };
		b3Body_ApplyLinearImpulseToCenter( attacker->body, impulse, true );
		PushEvent( EVT_PARRY, point.x, point.y, point.z, (float)att, (float)vic );
		return;
	}

	float factor = victim->braceTicks > 0 ? BRACE_HIT_FACTOR : 1.0f;
	float pop = victim->braceTicks > 0 ? 0.0f : 0.3f;
	float mass = b3Body_GetMass( victim->body );
	float k = DASH_HIT_KNOCKBACK * factor * speed * mass;
	b3Vec3 impulse = { nx * k, pop * k, nz * k };
	b3Body_ApplyLinearImpulseToCenter( victim->body, impulse, true );
	PushEvent( EVT_DASH_HIT, point.x, point.y, point.z, (float)att, (float)vic );

	// Knock the orb loose: carrying it paints a target on you.
	if ( victim->hasPower )
	{
		victim->hasPower = false;
		b3Pos vp = b3Body_GetPosition( victim->body );
		g_powerup.pos = ( b3Vec3 ){ vp.x, vp.y + 1.1f, vp.z };
		g_powerup.active = true;
		g_powerup.nextEventTick = g_frame + 600;
		PushEvent( EVT_ORB_SPAWN, g_powerup.pos.x, g_powerup.pos.y, g_powerup.pos.z, 1.0f, (float)vic );
	}
}

// Read Box3D hit events: emit feedback events and resolve dash shoves.
static void ProcessHits( void )
{
	b3ContactEvents events = b3World_GetContactEvents( g_world );
	for ( int i = 0; i < events.hitCount; ++i )
	{
		const b3ContactHitEvent* hit = events.hitEvents + i;
		int ia = PlayerIndexFromShape( hit->shapeIdA );
		int ib = PlayerIndexFromShape( hit->shapeIdB );

		if ( hit->approachSpeed >= HIT_EVENT_MIN_SPEED )
		{
			float who = (float)( ia >= 0 ? ia : ib );
			PushEvent( EVT_HIT, hit->point.x, hit->point.y, hit->point.z, hit->approachSpeed, who );
		}

		if ( ia >= 0 && ib >= 0 )
		{
			bool dashA = g_players[ia].dashCooldown > DASH_COOLDOWN_TICKS - DASH_HIT_WINDOW;
			bool dashB = g_players[ib].dashCooldown > DASH_COOLDOWN_TICKS - DASH_HIT_WINDOW;
			// Normal points from A to B.
			if ( dashA && !dashB )
			{
				ResolveDashHit( ia, ib, hit->normal.x, hit->normal.z, hit->approachSpeed, hit->point );
			}
			else if ( dashB && !dashA )
			{
				ResolveDashHit( ib, ia, -hit->normal.x, -hit->normal.z, hit->approachSpeed, hit->point );
			}
		}
	}
}

static void StepCrumble( void )
{
	// Promote WARNING tiles whose timer expired.
	for ( int i = 0; i < g_pieceCount; ++i )
	{
		Piece* piece = &g_pieces[i];
		if ( piece->state == PIECE_WARNING )
		{
			piece->timer -= 1;
			if ( piece->timer <= 0 )
			{
				b3Body_SetType( piece->body, b3_dynamicBody );
				piece->state = PIECE_FALLING;
				b3Pos pos = b3Body_GetPosition( piece->body );
				PushEvent( EVT_TILE_DROP, pos.x, pos.y, pos.z, 0.0f, -1.0f );
			}
		}
	}

	// Schedule the next tile, leaving a small final island standing.
	if ( g_frame >= g_crumbleStart && g_crumbleNext < g_pieceCount && g_standingPieces > MIN_STANDING_PIECES &&
		 ( g_frame - g_crumbleStart ) % g_crumbleInterval == 0 )
	{
		int idx = g_crumbleOrder[g_crumbleNext];
		g_crumbleNext += 1;
		if ( g_pieces[idx].state == PIECE_STATIC )
		{
			g_pieces[idx].state = PIECE_WARNING;
			g_pieces[idx].timer = WARNING_TICKS;
			g_standingPieces -= 1;
			b3Pos pos = b3Body_GetPosition( g_pieces[idx].body );
			PushEvent( EVT_TILE_WARN, pos.x, pos.y, pos.z, 0.0f, -1.0f );
		}
	}
}

// Hazards are inert until the countdown ends, then driven as pure functions
// of the elapsed frame — no accumulated state to drift.
static void StepHazards( void )
{
	if ( g_frame < COUNTDOWN_TICKS )
	{
		return;
	}
	uint32_t t = g_frame - COUNTDOWN_TICKS;

	for ( int i = 0; i < g_hazardCount; ++i )
	{
		Hazard* h = &g_hazards[i];
		if ( h->type == HAZARD_BEAM )
		{
			if ( t == 0 || t % 900 == 0 )
			{
				float speed = 0.9f + 0.35f * (float)( t / 900 );
				if ( speed > 2.3f )
				{
					speed = 2.3f;
				}
				b3Body_SetAngularVelocity( h->body, ( b3Vec3 ){ 0.0f, speed, 0.0f } );
			}
		}
		else if ( h->type == HAZARD_PISTON )
		{
			uint32_t phase = ( t + (uint32_t)i * 140u ) % 280u;
			b3Body_SetLinearVelocity( h->body, ( b3Vec3 ){ 0.0f, 0.0f, phase < 140u ? 2.2f : -2.2f } );
		}
	}
}

static void StepPowerup( void )
{
	if ( g_frame >= g_powerup.nextEventTick )
	{
		// (Re)place the orb above a random standing tile.
		int candidates[MAX_PIECES];
		int count = 0;
		for ( int i = 0; i < g_pieceCount; ++i )
		{
			if ( g_pieces[i].state == PIECE_STATIC )
			{
				candidates[count++] = i;
			}
		}
		if ( count > 0 )
		{
			int pick = candidates[RngNext() % (uint32_t)count];
			b3Pos tile = b3Body_GetPosition( g_pieces[pick].body );
			g_powerup.pos = ( b3Vec3 ){ tile.x, tile.y + PIECE_HY + 1.1f, tile.z };
			g_powerup.active = true;
			PushEvent( EVT_ORB_SPAWN, g_powerup.pos.x, g_powerup.pos.y, g_powerup.pos.z, 0.0f, -1.0f );
		}
		g_powerup.nextEventTick = g_frame + 600;
	}

	if ( !g_powerup.active )
	{
		return;
	}

	for ( int i = 0; i < g_playerCount; ++i )
	{
		Player* p = &g_players[i];
		if ( !p->alive || p->hasPower )
		{
			continue;
		}
		b3Pos pos = b3Body_GetPosition( p->body );
		float ddx = pos.x - g_powerup.pos.x;
		float ddz = pos.z - g_powerup.pos.z;
		float ddy = pos.y - g_powerup.pos.y;
		if ( ddx * ddx + ddz * ddz < 1.1f * 1.1f && ddy > -1.4f && ddy < 1.4f )
		{
			p->hasPower = true;
			g_powerup.active = false;
			g_powerup.nextEventTick = g_frame + 300;
			PushEvent( EVT_ORB_PICKUP, g_powerup.pos.x, g_powerup.pos.y, g_powerup.pos.z, 0.0f, (float)i );
			break;
		}
	}
}

TUMBO_EXPORT void tumbo_step( void )
{
	g_eventCount = 0;

	StepBots();
	StepPlayers();
	StepCrumble();
	StepHazards();
	StepPowerup();

	b3World_Step( g_world, TICK_DT, SUBSTEPS );
	g_frame += 1;

	ProcessHits();

	// Eliminations and cleanup.
	for ( int i = 0; i < g_playerCount; ++i )
	{
		Player* p = &g_players[i];
		if ( p->alive && b3Body_GetPosition( p->body ).y < FALL_Y )
		{
			p->alive = false;
			b3Pos pos = b3Body_GetPosition( p->body );
			PushEvent( EVT_FALL, pos.x, pos.y, pos.z, 0.0f, (float)i );
			b3Body_Disable( p->body );
		}
	}
	for ( int i = 0; i < g_pieceCount; ++i )
	{
		if ( g_pieces[i].state == PIECE_FALLING && b3Body_GetPosition( g_pieces[i].body ).y < PIECE_KILL_Y )
		{
			g_pieces[i].state = PIECE_GONE;
			b3Body_Disable( g_pieces[i].body );
		}
	}

	if ( g_winner == -1 )
	{
		int aliveCount = 0;
		int lastAlive = -1;
		for ( int i = 0; i < g_playerCount; ++i )
		{
			if ( g_players[i].alive )
			{
				aliveCount += 1;
				lastAlive = i;
			}
		}
		if ( g_playerCount > 1 && aliveCount <= 1 )
		{
			g_winner = aliveCount == 1 ? lastAlive : -2;
			PushEvent( EVT_ROUND_END, 0.0f, 0.0f, 0.0f, (float)g_winner, -1.0f );
		}
	}

	WriteState();
}

// FNV-1a over player kinematics — cheap per-tick desync detector for lockstep.
TUMBO_EXPORT uint32_t tumbo_hash( void )
{
	uint32_t h = 2166136261u;
	for ( int i = 0; i < g_playerCount; ++i )
	{
		float data[7];
		b3Pos pos = b3Body_GetPosition( g_players[i].body );
		b3Vec3 vel = b3Body_GetLinearVelocity( g_players[i].body );
		data[0] = pos.x;
		data[1] = pos.y;
		data[2] = pos.z;
		data[3] = vel.x;
		data[4] = vel.y;
		data[5] = vel.z;
		data[6] = g_players[i].alive ? 1.0f : 0.0f;
		const uint8_t* bytes = (const uint8_t*)data;
		for ( size_t b = 0; b < sizeof( data ); ++b )
		{
			h = ( h ^ bytes[b] ) * 16777619u;
		}
	}
	return h;
}
