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
#define MAX_PIECES 512
#define MAX_HAZARDS 4

// 20 hand-crafted arenas + 50 procedurally generated ones. Generated levels
// derive ONLY from their id (own PCG stream), so every peer builds the exact
// same arena for level N regardless of round seed.
#define LEVEL_HANDMADE 20
#define LEVEL_COUNT 70

// Custom maps: JS writes a compact byte blob (see BuildCustomLevel for the
// format) and initializes with level == LEVEL_CUSTOM. The blob is part of the
// deterministic setup, so lockstep peers must load identical bytes.
#define LEVEL_CUSTOM 70
#define CUSTOM_DATA_MAX 1024

// Bomberman-style pickups: the orb now has a type.
enum
{
	ORB_SUPER = 0,	// next dash x2.3 (the classic)
	ORB_TURBO = 1,	// permanent (per round) speed stack
	ORB_MEGA = 2,	// permanent (per round) size/mass stack
};
#define TURBO_STEP 0.16f
#define TURBO_MAX 1.5f
#define MEGA_STEP 1.16f
#define MEGA_MAX 1.55f

// Game modes (tumbo_set_mode). All win conditions resolve inside the sim.
enum
{
	MODE_SUMO = 0,	   // last one standing (default)
	MODE_KOTH = 1,	   // hold the zone ALONE for param seconds
	MODE_COSECHA = 2,  // first to param orbs
	MODE_MALDITO = 3,  // hot potato: the cursed one explodes at 0
};

#define ZONE_RADIUS 2.3f
#define ZONE_MOVE_TICKS 600
#define CURSE_IMMUNITY_TICKS 90

#define TICK_DT ( 1.0f / 60.0f )
#define SUBSTEPS 4

#define PIECE_STEP 1.5f
#define PIECE_HX 0.74f
#define PIECE_HY 0.4f
#define PIECE_HZ 0.74f

#define PLAYER_RADIUS 0.6f // base; each level picks its own ball size
#define MOVE_ACCEL 28.0f
#define AIR_CONTROL 0.45f
#define MAX_MOVE_SPEED 9.0f
#define DASH_SPEED 7.5f
#define DASH_COOLDOWN_TICKS 45
#define POWER_DASH_MULT 2.3f
#define JUMP_SPEED 7.0f
#define JUMP_COOLDOWN_TICKS 14
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
#define FLAG_CURSED 1024

// Mode section appended to the state buffer: [mode, m0, m1, m2] + 8 scores.
#define MODE_FLOATS 12

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
	LEVEL_CRUZ = 8,
	LEVEL_ASPAS = 9,
	LEVEL_GEMELAS = 10,
	LEVEL_PANAL = 11,
	LEVEL_DIANA = 12,
	LEVEL_VOLCAN = 13,
	LEVEL_ZIGURAT = 14,
	LEVEL_TORRES = 15,
	LEVEL_RULETA2 = 16,
	LEVEL_FABRICA = 17,
	LEVEL_MARTILLO = 18,
	LEVEL_CALLES = 19,
};

enum
{
	HAZARD_BEAM = 0,	   // spins in place; a = base angular speed
	HAZARD_PISTON = 1,	   // sweeps along Z; a = speed, b = phase ticks
	HAZARD_ORBITER = 2,	   // orbits the center; a = angular speed, b = phase, c = radius
	HAZARD_PISTON_X = 3,   // sweeps along X; a = speed, b = phase ticks
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
	EVT_CURSE = 11,		 // a = newly cursed, b = previous (-1 at round start)
	EVT_ZONE = 12,		 // zone moved to (x, z)
	EVT_MODE_POINT = 13, // a = player, b = new score (zone seconds / orbs)
};

#define MAX_EVENTS 32
#define EVENT_FLOATS 6

typedef struct Player
{
	b3BodyId body;
	b3ShapeId shape;
	b3Vec3 facing;
	uint32_t prevIn;
	int dashCooldown;
	int jumpCooldown;
	int jumpBuffer;
	int dashBuffer;
	int coyote;
	int braceTicks;
	float ballR;	 // current radius (MEGA grows it)
	float baseR;	 // the level's base radius
	float speedMult; // TURBO stacks
	bool hasPower;
	bool alive;
} Player;

// Tile specials, packed into the state float as state + special*16.
enum
{
	SPECIAL_NONE = 0,
	SPECIAL_BOOST = 1,	 // accelerates along (dirX, dirZ) while you roll on it
	SPECIAL_BOUNCY = 2,	 // trampoline material
};

#define BOOST_ACCEL 42.0f
#define BOOST_MAX_SPEED 15.0f

typedef struct Piece
{
	b3BodyId body;
	int state;
	int timer;	   // ticks left in WARNING before dropping
	int priority;  // crumble group, lower falls first
	int special;
	float dirX, dirZ; // boost direction (unit, XZ)
} Piece;

typedef struct Hazard
{
	b3BodyId body;
	b3Vec3 halfExtents;
	int type;
	float a, b, c; // per-type params, see hazard enum
} Hazard;

typedef struct Powerup
{
	b3Vec3 pos;
	int type;
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
	int braceFor;	 // short parry reaction, in ticks (holding forever deadlocks)
	bool pulseDash;
	bool pulseJump;
	float lastX, lastZ; // position at the previous replan
	int stuck;			// consecutive replans without real displacement
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

// Generated-level round data, filled by BuildGenerated.
static float g_genSpawns[MAX_PLAYERS][3];
static int g_genSpawnCount;
static float g_genBallR;
static float g_state[STATE_HEADER + STATE_STRIDE * ( MAX_PLAYERS + MAX_PIECES ) + HAZARD_STRIDE * MAX_HAZARDS + 4 +
					 MODE_FLOATS];

// Game-mode state.
static int g_mode;
static int g_modeParam;
static int g_scores[MAX_PLAYERS];
static float g_zoneX, g_zoneZ;
static bool g_zoneActive;
static uint32_t g_zoneMoveAt;
static int g_cursed;
static int g_curseTicks;
static int g_curseImmunity;
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
	return STATE_HEADER + STATE_STRIDE * ( g_playerCount + g_pieceCount ) + HAZARD_STRIDE * g_hazardCount + 4 +
		   MODE_FLOATS;
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

// Set the game mode. Call after tumbo_init and before the first step,
// identically on every lockstep peer. KOTH: param = seconds to hold alone.
// COSECHA: param = orbs. MALDITO: param = curse timer seconds.
TUMBO_EXPORT void tumbo_set_mode( int mode, int param );

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
	g_bots[slot].braceFor = 0;
	g_bots[slot].pulseDash = false;
	g_bots[slot].pulseJump = false;
	g_bots[slot].lastX = 0.0f;
	g_bots[slot].lastZ = 0.0f;
	g_bots[slot].stuck = 0;
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
		int rBits = (int)( p->ballR * 20.0f + 0.5f ) & 31; // bits 11-15, 0.05m units
		int flags = ( p->alive ? FLAG_ALIVE : 0 ) | ( p->dashCooldown == 0 ? FLAG_DASH_READY : 0 ) |
					( p->hasPower ? FLAG_HAS_POWER : 0 ) | ( cd << FLAG_CD_SHIFT ) |
					( p->braceTicks > 0 ? FLAG_BRACED : 0 ) | ( g_cursed == i ? FLAG_CURSED : 0 ) | ( rBits << 11 );
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
		out[7] = (float)( g_pieces[i].state + g_pieces[i].special * 16 );
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
	out[3] = g_powerup.active ? (float)( 1 + g_powerup.type ) : 0.0f;
	out += 4;

	out[0] = (float)g_mode;
	if ( g_mode == MODE_MALDITO )
	{
		out[1] = (float)g_cursed;
		out[2] = (float)g_curseTicks;
	}
	else
	{
		out[1] = g_zoneActive ? g_zoneX : 0.0f;
		out[2] = g_zoneActive ? g_zoneZ : -1000.0f;
	}
	out[3] = (float)g_modeParam;
	for ( int i = 0; i < MAX_PLAYERS; ++i )
	{
		out[4 + i] = (float)g_scores[i];
	}
}

// ---------------------------------------------------------------------------
// Level construction
// ---------------------------------------------------------------------------

// Full-control tile: optional special behavior and an optional pitch that
// turns the slab into a ramp. rampDir: -1 flat, 0 rises toward +X, 1 toward
// -X, 2 toward +Z, 3 toward -Z (one tile climbs 0.8m — jumpable, not dashable).
static void AddPieceEx( float cx, float cz, float topY, int priority, const b3BoxHull* hull, int special, float dirX,
						float dirZ, int rampDir )
{
	if ( g_pieceCount >= MAX_PIECES )
	{
		return;
	}

	b3BodyDef bodyDef = b3DefaultBodyDef();
	bodyDef.type = b3_staticBody;

	if ( rampDir >= 0 )
	{
		// Ramp slab: center sits halfway up the climb, pitched ~28°.
		float half = 0.4899f * 0.5f; // atan2(0.8, 1.5) / 2
		float s = sinf( half );
		float c = cosf( half );
		switch ( rampDir )
		{
			case 0: // rises toward +X: rotate about +Z
				bodyDef.rotation = ( b3Quat ){ { 0.0f, 0.0f, s }, c };
				break;
			case 1: // rises toward -X
				bodyDef.rotation = ( b3Quat ){ { 0.0f, 0.0f, -s }, c };
				break;
			case 2: // rises toward +Z: rotate about -X
				bodyDef.rotation = ( b3Quat ){ { -s, 0.0f, 0.0f }, c };
				break;
			default: // rises toward -Z
				bodyDef.rotation = ( b3Quat ){ { s, 0.0f, 0.0f }, c };
				break;
		}
		bodyDef.position = ( b3Pos ){ cx, topY + 0.4f - PIECE_HY, cz };
	}
	else
	{
		bodyDef.position = ( b3Pos ){ cx, topY - PIECE_HY, cz };
	}
	b3BodyId body = b3CreateBody( g_world, &bodyDef );

	b3ShapeDef shapeDef = b3DefaultShapeDef();
	shapeDef.baseMaterial.friction = 0.7f;
	shapeDef.baseMaterial.restitution = special == SPECIAL_BOUNCY ? 1.05f : 0.0f;
	shapeDef.density = 800.0f;
	shapeDef.filter.categoryBits = CAT_WORLD;
	b3CreateHullShape( body, &shapeDef, &hull->base );

	g_pieces[g_pieceCount].body = body;
	g_pieces[g_pieceCount].state = PIECE_STATIC;
	g_pieces[g_pieceCount].timer = 0;
	g_pieces[g_pieceCount].priority = priority;
	g_pieces[g_pieceCount].special = special;
	g_pieces[g_pieceCount].dirX = dirX;
	g_pieces[g_pieceCount].dirZ = dirZ;
	g_pieceCount += 1;
}

static void AddPiece( float cx, float cz, float topY, int priority, const b3BoxHull* hull )
{
	AddPieceEx( cx, cz, topY, priority, hull, SPECIAL_NONE, 0.0f, 0.0f, -1 );
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
static void AddBoxHazard( b3Vec3 pos, b3Vec3 half, int type, float a, float b, float c )
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
	g_hazards[g_hazardCount].a = a;
	g_hazards[g_hazardCount].b = b;
	g_hazards[g_hazardCount].c = c;
	g_hazardCount += 1;
}

static void BuildLevel( int level, const b3BoxHull* hull )
{
	int extent = 9;
	for ( int gx = -extent; gx <= extent; ++gx )
	{
		for ( int gz = -extent; gz <= extent; ++gz )
		{
			float cx = gx * PIECE_STEP;
			float cz = gz * PIECE_STEP;
			float d2 = cx * cx + cz * cz;

			if ( level == LEVEL_CLASICA )
			{
				if ( d2 <= 13.4f * 13.4f )
				{
					AddPiece( cx, cz, 0.0f, 0, hull );
				}
			}
			else if ( level == LEVEL_ANILLO )
			{
				if ( d2 <= 13.4f * 13.4f && d2 >= 6.0f * 6.0f )
				{
					// Velodrome: the ring's centerline is a counterclockwise
					// speed lane. Fighting against the current is a choice.
					float r = sqrtf( d2 );
					if ( r >= 9.6f && r <= 11.2f )
					{
						AddPieceEx( cx, cz, 0.0f, 0, hull, SPECIAL_BOOST, -cz / r, cx / r, -1 );
					}
					else
					{
						AddPiece( cx, cz, 0.0f, 0, hull );
					}
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
				if ( d2 <= 13.4f * 13.4f )
				{
					AddPiece( cx, cz, 0.0f, 0, hull );
				}
			}
			else if ( level == LEVEL_PIRAMIDE )
			{
				// Three concentric square terraces; king of the hill. Ramps
				// on the four axis midlines let you ROLL up with momentum.
				int ax = gx < 0 ? -gx : gx;
				int az = gz < 0 ? -gz : gz;
				int m = ax > az ? ax : az;
				if ( m <= 6 )
				{
					float h = m <= 2 ? 1.6f : ( m <= 4 ? 0.8f : 0.0f );
					int prio = m >= 5 ? 0 : ( m >= 3 ? 1 : 2 );
					bool onAxis = ( gz == 0 && ax > 0 ) || ( gx == 0 && az > 0 );
					if ( onAxis && ( m == 3 || m == 5 ) )
					{
						// Rises toward the center: -X for +x arm, +X for -x arm...
						int dir = gz == 0 ? ( gx > 0 ? 1 : 0 ) : ( gz > 0 ? 3 : 2 );
						AddPieceEx( cx, cz, m == 3 ? 0.8f : 0.0f, prio, hull, SPECIAL_NONE, 0.0f, 0.0f, dir );
					}
					else
					{
						AddPiece( cx, cz, h, prio, hull );
					}
				}
			}
			else if ( level == LEVEL_HERRADURA )
			{
				// Ring with an opening at -Z; the collapse wave sweeps from
				// one horn of the U to the other. Push rivals INTO the wave.
				if ( d2 <= 13.4f * 13.4f && d2 >= 6.0f * 6.0f && !( cz < -4.5f && ( cx < 5.1f && cx > -5.1f ) ) )
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
			else if ( level == LEVEL_TARIMAS )
			{
				// Archipelago of pads split by exactly one-tile gaps; pads
				// sink in a fixed, learnable order. Central plaza dies last.
				int prio = -1;
				float h = 0.0f;
				if ( gx >= -2 && gx <= 2 && gz >= -2 && gz <= 2 )
				{
					prio = 5;
					// Plaza corners are trampolines: bounce back up to the pads.
					int axT = gx < 0 ? -gx : gx;
					int azT = gz < 0 ? -gz : gz;
					if ( axT == 2 && azT == 2 )
					{
						AddPieceEx( cx, cz, 0.0f, prio, hull, SPECIAL_BOUNCY, 0.0f, 0.0f, -1 );
						continue;
					}
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
			else if ( level == LEVEL_CRUZ )
			{
				// Plus-shaped cross; arms rot from the tips into a center melee.
				int ax = gx < 0 ? -gx : gx;
				int az = gz < 0 ? -gz : gz;
				if ( ( az <= 1 && ax <= 6 ) || ( ax <= 1 && az <= 6 ) )
				{
					int m = ax > az ? ax : az;
					AddPiece( cx, cz, 0.0f, m, hull );
				}
			}
			else if ( level == LEVEL_ASPAS )
			{
				// Pinwheel: four arms bent by radius, plus a safe hub.
				if ( d2 <= 9.4f * 9.4f )
				{
					float r = sqrtf( d2 );
					float rel = fmodf( atan2f( cz, cx ) + r * 0.32f + 12.566371f, 1.5707963f );
					if ( r <= 2.2f || rel < 0.85f )
					{
						AddPiece( cx, cz, 0.0f, r <= 2.2f ? 20 : (int)( 12.0f - r ), hull );
					}
				}
			}
			else if ( level == LEVEL_GEMELAS )
			{
				// Twin discs and a single doomed crossing — the bridge is a
				// launcher that flings you toward the far island.
				float dl = ( cx + 6.75f ) * ( cx + 6.75f ) + cz * cz;
				float dr = ( cx - 6.75f ) * ( cx - 6.75f ) + cz * cz;
				bool disc = dl <= 4.4f * 4.4f || dr <= 4.4f * 4.4f;
				bool bridge = gz == 0 && cx > -6.75f && cx < 6.75f;
				if ( disc )
				{
					float best = dl < dr ? dl : dr;
					AddPiece( cx, cz, 0.0f, best > 2.9f * 2.9f ? 1 : 2, hull );
				}
				else if ( bridge )
				{
					if ( gx == 0 )
					{
						// Keep the center tile neutral so the level stays mirror-symmetric.
						AddPiece( cx, cz, 0.0f, 0, hull );
					}
					else
					{
						AddPieceEx( cx, cz, 0.0f, 0, hull, SPECIAL_BOOST, cx < 0.0f ? 1.0f : -1.0f, 0.0f, -1 );
					}
				}
			}
			else if ( level == LEVEL_PANAL )
			{
				// Field of 2x2 pads with one-tile gaps everywhere: pure jumps.
				int mx = ( ( gx % 3 ) + 3 ) % 3;
				int mz = ( ( gz % 3 ) + 3 ) % 3;
				if ( mx != 2 && mz != 2 && d2 <= 13.4f * 13.4f )
				{
					AddPiece( cx, cz, 0.0f, 0, hull );
				}
			}
			else if ( level == LEVEL_DIANA )
			{
				// Concentric rings with real gaps; migrate inward by jumping.
				float r = sqrtf( d2 );
				if ( r <= 3.5f )
				{
					AddPiece( cx, cz, 0.0f, 2, hull );
				}
				else if ( r >= 6.5f && r <= 9.0f )
				{
					AddPiece( cx, cz, 0.0f, 1, hull );
				}
				else if ( r >= 11.5f && r <= 13.4f )
				{
					AddPiece( cx, cz, 0.0f, 0, hull );
				}
			}
			else if ( level == LEVEL_VOLCAN )
			{
				// The crater grows: crumble radiates from the center outward.
				// The raised rim is a trampoline — your last-ditch escape.
				float r = sqrtf( d2 );
				if ( r <= 13.4f && r >= 2.4f )
				{
					if ( r >= 11.8f )
					{
						AddPieceEx( cx, cz, 0.8f, (int)( r * 1.4f ), hull, SPECIAL_BOUNCY, 0.0f, 0.0f, -1 );
					}
					else
					{
						AddPiece( cx, cz, 0.0f, (int)( r * 1.4f ), hull );
					}
				}
			}
			else if ( level == LEVEL_ZIGURAT )
			{
				// Four square terraces up to 2.4m with ramp staircases on the
				// axis midlines; the base erodes first.
				int ax = gx < 0 ? -gx : gx;
				int az = gz < 0 ? -gz : gz;
				int m = ax > az ? ax : az;
				if ( m <= 7 && d2 <= 10.4f * 10.4f )
				{
					int tier = m <= 1 ? 3 : ( m <= 3 ? 2 : ( m <= 5 ? 1 : 0 ) );
					// Ramps only on the inner tier boundaries: the outer ring
					// stays flat so nobody spawns on (or rolls off) a slope.
					bool onAxis = ( gz == 0 && ax > 0 ) || ( gx == 0 && az > 0 );
					if ( onAxis && ( m == 2 || m == 4 ) )
					{
						int dir = gz == 0 ? ( gx > 0 ? 1 : 0 ) : ( gz > 0 ? 3 : 2 );
						AddPieceEx( cx, cz, 0.8f * (float)tier, tier, hull, SPECIAL_NONE, 0.0f, 0.0f, dir );
					}
					else
					{
						AddPiece( cx, cz, 0.8f * (float)tier, tier, hull );
					}
				}
			}
			else if ( level == LEVEL_TORRES )
			{
				// Low battlefield that collapses from the middle, with two
				// high towers (and ramps) as endgame refuges.
				int ax = gx < 0 ? -gx : gx;
				int az = gz < 0 ? -gz : gz;
				if ( ax >= 6 && ax <= 7 && az <= 1 )
				{
					AddPiece( cx, cz, 1.6f, 20, hull );
				}
				else if ( ax == 5 && az <= 1 )
				{
					AddPiece( cx, cz, 0.8f, 15, hull );
				}
				else if ( ax <= 4 && az <= 3 )
				{
					AddPiece( cx, cz, 0.0f, ax, hull );
				}
			}
			else if ( level == LEVEL_RULETA2 )
			{
				// Donut with two counter-rotating beams at different speeds.
				if ( d2 <= 9.4f * 9.4f && d2 >= 3.0f * 3.0f )
				{
					AddPiece( cx, cz, 0.0f, 0, hull );
				}
			}
			else if ( level == LEVEL_FABRICA )
			{
				// Square floor swept by four staggered pistons.
				int ax = gx < 0 ? -gx : gx;
				int az = gz < 0 ? -gz : gz;
				if ( ax <= 6 && az <= 6 )
				{
					AddPiece( cx, cz, 0.0f, 0, hull );
				}
			}
			else if ( level == LEVEL_MARTILLO )
			{
				// Big disc patrolled by an orbiting wrecking block.
				if ( d2 <= 13.4f * 13.4f )
				{
					AddPiece( cx, cz, 0.0f, 0, hull );
				}
			}
			else // LEVEL_CALLES
			{
				// Street lattice; random collapse keeps rerouting everyone.
				// The two main avenues are one-way speed lanes.
				int mx = ( ( gx % 3 ) + 3 ) % 3;
				int mz = ( ( gz % 3 ) + 3 ) % 3;
				if ( ( mx == 0 || mz == 0 ) && d2 <= 13.4f * 13.4f )
				{
					if ( gz == 0 && gx != 0 )
					{
						AddPieceEx( cx, cz, 0.0f, 0, hull, SPECIAL_BOOST, 1.0f, 0.0f, -1 );
					}
					else if ( gx == 0 && gz != 0 )
					{
						AddPieceEx( cx, cz, 0.0f, 0, hull, SPECIAL_BOOST, 0.0f, 1.0f, -1 );
					}
					else
					{
						AddPiece( cx, cz, 0.0f, 0, hull );
					}
				}
			}
		}
	}

	switch ( level )
	{
		case LEVEL_CLASICA:
			SortCrumbleOrder();
			g_crumbleStart = 600;
			g_crumbleInterval = 11;
			break;
		case LEVEL_ANILLO:
			SortCrumbleOrder();
			g_crumbleStart = 540;
			g_crumbleInterval = 11;
			break;
		case LEVEL_RULETA:
			ShuffleCrumbleOrder();
			AddBoxHazard( ( b3Vec3 ){ 0.0f, 0.95f, 0.0f }, ( b3Vec3 ){ 12.9f, 0.3f, 0.32f }, HAZARD_BEAM, 0.8f, 0.0f, 0.0f );
			g_crumbleStart = 420;
			g_crumbleInterval = 8;
			break;
		case LEVEL_PIRAMIDE:
			SortCrumbleOrder();
			g_crumbleStart = 600;
			g_crumbleInterval = 18;
			break;
		case LEVEL_HERRADURA:
			SortCrumbleOrder();
			g_crumbleStart = 480;
			g_crumbleInterval = 6;
			break;
		case LEVEL_PASARELA:
			SortCrumbleOrder();
			AddBoxHazard( ( b3Vec3 ){ -3.0f, 0.5f, -2.6f }, ( b3Vec3 ){ 0.5f, 0.5f, 0.75f }, HAZARD_PISTON, 2.2f, 0.0f, 0.0f );
			AddBoxHazard( ( b3Vec3 ){ 3.0f, 0.5f, 2.6f }, ( b3Vec3 ){ 0.5f, 0.5f, 0.75f }, HAZARD_PISTON, 2.2f, 140.0f, 0.0f );
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
		case LEVEL_CRUZ:
			SortCrumbleOrder();
			g_crumbleStart = 540;
			g_crumbleInterval = 22;
			break;
		case LEVEL_ASPAS:
			SortCrumbleOrder();
			g_crumbleStart = 540;
			g_crumbleInterval = 20;
			break;
		case LEVEL_GEMELAS:
			SortCrumbleOrder();
			g_crumbleStart = 480;
			g_crumbleInterval = 22;
			break;
		case LEVEL_PANAL:
			SortCrumbleOrder();
			g_crumbleStart = 600;
			g_crumbleInterval = 8;
			break;
		case LEVEL_DIANA:
			SortCrumbleOrder();
			g_crumbleStart = 540;
			g_crumbleInterval = 9;
			break;
		case LEVEL_VOLCAN:
			SortCrumbleOrder();
			g_crumbleStart = 420;
			g_crumbleInterval = 7;
			break;
		case LEVEL_ZIGURAT:
			SortCrumbleOrder();
			g_crumbleStart = 600;
			g_crumbleInterval = 14;
			break;
		case LEVEL_TORRES:
			SortCrumbleOrder();
			g_crumbleStart = 480;
			g_crumbleInterval = 20;
			break;
		case LEVEL_RULETA2:
			ShuffleCrumbleOrder();
			AddBoxHazard( ( b3Vec3 ){ 0.0f, 0.95f, 0.0f }, ( b3Vec3 ){ 8.1f, 0.3f, 0.32f }, HAZARD_BEAM, 0.8f, 0.0f, 0.0f );
			AddBoxHazard( ( b3Vec3 ){ 0.0f, 0.95f, 0.0f }, ( b3Vec3 ){ 4.2f, 0.3f, 0.32f }, HAZARD_BEAM, -1.7f, 0.0f, 0.0f );
			g_crumbleStart = 480;
			g_crumbleInterval = 20;
			break;
		case LEVEL_FABRICA:
			SortCrumbleOrder();
			AddBoxHazard( ( b3Vec3 ){ -4.5f, 0.5f, -6.0f }, ( b3Vec3 ){ 0.5f, 0.5f, 0.75f }, HAZARD_PISTON, 2.6f, 0.0f, 0.0f );
			AddBoxHazard( ( b3Vec3 ){ 4.5f, 0.5f, 6.0f }, ( b3Vec3 ){ 0.5f, 0.5f, 0.75f }, HAZARD_PISTON, 2.6f, 140.0f, 0.0f );
			AddBoxHazard( ( b3Vec3 ){ -6.0f, 0.5f, 4.5f }, ( b3Vec3 ){ 0.75f, 0.5f, 0.5f }, HAZARD_PISTON_X, 2.6f, 70.0f, 0.0f );
			AddBoxHazard( ( b3Vec3 ){ 6.0f, 0.5f, -4.5f }, ( b3Vec3 ){ 0.75f, 0.5f, 0.5f }, HAZARD_PISTON_X, 2.6f, 210.0f, 0.0f );
			g_crumbleStart = 540;
			g_crumbleInterval = 18;
			break;
		case LEVEL_MARTILLO:
			SortCrumbleOrder();
			AddBoxHazard( ( b3Vec3 ){ 10.4f, 0.95f, 0.0f }, ( b3Vec3 ){ 1.2f, 0.7f, 1.2f }, HAZARD_ORBITER, 0.5f, 0.0f, 10.4f );
			g_crumbleStart = 540;
			g_crumbleInterval = 8;
			break;
		case LEVEL_CALLES:
			ShuffleCrumbleOrder();
			g_crumbleStart = 480;
			g_crumbleInterval = 5;
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
		AddBoxHazard( ( b3Vec3 ){ 0.0f, 0.95f, 0.0f }, ( b3Vec3 ){ (float)d[6] * 0.1f, 0.3f, 0.32f }, HAZARD_BEAM, 0.9f,
					  0.0f, 0.0f );
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

// ---------------------------------------------------------------------------
// Procedural arenas (levels 20..69). Everything derives from the level id via
// a dedicated RNG stream, so every peer builds bit-identical geometry no
// matter the round seed. Six families keep the variety honest.
// ---------------------------------------------------------------------------

static int TileIndexAt( float x, float z );

static uint32_t g_genRng;

static uint32_t GenNext( void )
{
	g_genRng = g_genRng * 1664525u + 1013904223u;
	return g_genRng >> 8;
}

static float GenF( float lo, float hi )
{
	return lo + ( hi - lo ) * (float)( GenNext() % 1024u ) / 1023.0f;
}

// Greedy max-min spread over plain tiles: spawns as far apart as possible,
// never on boost lanes, never over the void.
static void PickGeneratedSpawns( void )
{
	g_genSpawnCount = 0;
	int chosen[MAX_PLAYERS];
	for ( int s = 0; s < MAX_PLAYERS; ++s )
	{
		int best = -1;
		float bestScore = -1.0f;
		for ( int i = 0; i < g_pieceCount; ++i )
		{
			if ( g_pieces[i].special != SPECIAL_NONE )
			{
				continue;
			}
			b3Pos tp = b3Body_GetPosition( g_pieces[i].body );
			float score;
			if ( s == 0 )
			{
				score = tp.x * tp.x + tp.z * tp.z;
			}
			else
			{
				score = 1e30f;
				for ( int k = 0; k < s; ++k )
				{
					b3Pos cp = b3Body_GetPosition( g_pieces[chosen[k]].body );
					float dx = tp.x - cp.x;
					float dz = tp.z - cp.z;
					float dd = dx * dx + dz * dz;
					if ( dd < score )
					{
						score = dd;
					}
				}
			}
			if ( score > bestScore )
			{
				bestScore = score;
				best = i;
			}
		}
		if ( best < 0 )
		{
			break;
		}
		chosen[s] = best;
		b3Pos tp = b3Body_GetPosition( g_pieces[best].body );
		g_genSpawns[s][0] = tp.x;
		g_genSpawns[s][1] = tp.y + PIECE_HY;
		g_genSpawns[s][2] = tp.z;
		g_genSpawnCount += 1;
	}
}

static void BuildGenerated( int level, const b3BoxHull* hull )
{
	g_genRng = (uint32_t)level * 2654435761u + 977u;
	int fam = ( level - LEVEL_HANDMADE ) % 6;
	float R = GenF( 9.0f, 13.4f );
	static const float sizes[7] = { 0.45f, 0.5f, 0.55f, 0.6f, 0.6f, 0.75f, 0.9f };
	g_genBallR = sizes[GenNext() % 7u];

	// Family parameters, all rolled up-front so the RNG stream is stable.
	int holes = (int)( GenNext() % 4u );
	float hx[3], hz[3], hr[3];
	for ( int k = 0; k < 3; ++k )
	{
		float a = GenF( 0.0f, 6.2831f );
		float rr = GenF( 0.25f, 0.75f ) * R;
		hx[k] = cosf( a ) * rr;
		hz[k] = sinf( a ) * rr;
		hr[k] = GenF( 1.6f, 3.4f );
	}
	int nIsl = 3 + (int)( GenNext() % 4u );
	float ix[6], iz[6], ir[6];
	for ( int k = 0; k < 6; ++k )
	{
		float a = 6.2831f * (float)k / (float)( nIsl > 0 ? nIsl : 1 ) + GenF( -0.3f, 0.3f );
		float rr = GenF( 0.45f, 0.75f ) * R;
		ix[k] = cosf( a ) * rr;
		iz[k] = sinf( a ) * rr;
		ir[k] = GenF( 2.4f, 4.6f );
	}
	bool hub = ( GenNext() & 1u ) != 0u;
	float ringIn = GenF( 0.28f, 0.42f ) * R;
	float ringMid = GenF( 0.55f, 0.7f ) * R;
	int pitch = 2 + (int)( GenNext() % 2u );
	int skipMod = 5 + (int)( GenNext() % 4u );
	bool cheby = ( GenNext() & 1u ) != 0u;
	int tierEvery = 2 + (int)( GenNext() % 2u );
	int padSize = 2 + (int)( GenNext() % 2u );

	for ( int gx = -9; gx <= 9; ++gx )
	{
		for ( int gz = -9; gz <= 9; ++gz )
		{
			float cx = gx * PIECE_STEP;
			float cz = gz * PIECE_STEP;
			float d2 = cx * cx + cz * cz;
			float r = sqrtf( d2 );
			bool put = false;
			float h = 0.0f;
			int prio = 0;
			int special = SPECIAL_NONE;

			if ( fam == 0 )
			{
				// Holed disc: big open brawl with deadly potholes.
				if ( r <= R )
				{
					put = true;
					for ( int k = 0; k < holes; ++k )
					{
						float dx = cx - hx[k];
						float dz = cz - hz[k];
						if ( dx * dx + dz * dz < hr[k] * hr[k] )
						{
							put = false;
						}
					}
				}
			}
			else if ( fam == 1 )
			{
				// Island cluster with a doomed escape corridor.
				for ( int k = 0; k < nIsl; ++k )
				{
					float dx = cx - ix[k];
					float dz = cz - iz[k];
					if ( dx * dx + dz * dz <= ir[k] * ir[k] )
					{
						put = true;
						prio = 1;
					}
				}
				if ( hub && r <= 3.2f )
				{
					put = true;
					prio = 3;
				}
				if ( !put && gz == 0 && r <= R * 0.9f )
				{
					put = true;
					prio = 0; // the corridor falls first
				}
			}
			else if ( fam == 2 )
			{
				// Concentric rings with a jumpable moat.
				if ( ( r >= ringIn && r <= ringMid ) || ( r >= ringMid + 2.2f && r <= R ) )
				{
					put = true;
					prio = r > ringMid ? 0 : 2;
				}
				if ( hub && r <= 2.4f )
				{
					put = true;
					prio = 4;
				}
			}
			else if ( fam == 3 )
			{
				// Street lattice with potholes.
				int mx = ( ( gx % pitch ) + pitch ) % pitch;
				int mz = ( ( gz % pitch ) + pitch ) % pitch;
				if ( ( mx == 0 || mz == 0 ) && r <= R )
				{
					put = ( ( gx * 31 + gz * 17 + level ) % skipMod ) != 0;
				}
			}
			else if ( fam == 4 )
			{
				// Terraced hill, square or diamond silhouette, with ramps.
				int ax = gx < 0 ? -gx : gx;
				int az = gz < 0 ? -gz : gz;
				int m = cheby ? ( ax > az ? ax : az ) : ( ax + az + 1 ) / 2;
				if ( m <= 8 && r <= R )
				{
					int tier = ( 8 - m ) / tierEvery;
					if ( tier > 3 )
					{
						tier = 3;
					}
					h = 0.8f * (float)tier;
					prio = 3 - tier;
					bool onAxis = ( gz == 0 && ax > 0 ) || ( gx == 0 && az > 0 );
					if ( onAxis && ( ( 8 - m ) % tierEvery ) == ( tierEvery - 1 ) && tier < 3 )
					{
						int dir = gz == 0 ? ( gx > 0 ? 1 : 0 ) : ( gz > 0 ? 3 : 2 );
						AddPieceEx( cx, cz, h, prio, hull, SPECIAL_NONE, 0.0f, 0.0f, dir );
					}
					else
					{
						put = true;
					}
				}
			}
			else
			{
				// Jump-pad archipelago, some pads bouncy.
				int mx = ( ( gx % 3 ) + 3 ) % 3;
				int mz = ( ( gz % 3 ) + 3 ) % 3;
				if ( mx < padSize && mz < padSize && r <= R )
				{
					put = ( ( gx * 13 + gz * 7 + level ) % skipMod ) != 0;
					if ( put && ( ( gx + gz + level ) % 9 ) == 0 )
					{
						special = SPECIAL_BOUNCY;
					}
				}
			}

			if ( put )
			{
				AddPieceEx( cx, cz, h, prio, hull, special, 0.0f, 0.0f, -1 );
			}
		}
	}

	// Degenerate roll (tiny floor)? Backfill a plain disc: rounds must work.
	if ( g_pieceCount < 24 )
	{
		for ( int gx = -7; gx <= 7; ++gx )
		{
			for ( int gz = -7; gz <= 7; ++gz )
			{
				float cx = gx * PIECE_STEP;
				float cz = gz * PIECE_STEP;
				if ( cx * cx + cz * cz <= 10.4f * 10.4f && TileIndexAt( cx, cz ) < 0 )
				{
					AddPiece( cx, cz, 0.0f, 0, hull );
				}
			}
		}
	}

	// Optional hazard: 30% spinning beam, 20% orbiting hammer.
	uint32_t roll = GenNext() % 10u;
	if ( roll < 3u )
	{
		float w = GenF( 0.6f, 1.0f ) * ( ( GenNext() & 1u ) ? 1.0f : -1.0f );
		AddBoxHazard( ( b3Vec3 ){ 0.0f, 0.95f, 0.0f }, ( b3Vec3 ){ R - 0.6f, 0.3f, 0.32f }, HAZARD_BEAM, w, 0.0f, 0.0f );
	}
	else if ( roll < 5u )
	{
		float orbR = R * 0.72f;
		AddBoxHazard( ( b3Vec3 ){ orbR, 0.95f, 0.0f }, ( b3Vec3 ){ 1.1f, 0.7f, 1.1f }, HAZARD_ORBITER,
					  GenF( 0.4f, 0.65f ), 0.0f, orbR );
	}

	SortCrumbleOrder();
	if ( ( GenNext() % 10u ) < 3u )
	{
		ShuffleCrumbleOrder();
	}
	g_crumbleStart = 420u + ( GenNext() % 5u ) * 60u;
	int interval = 2200 / ( g_pieceCount > 0 ? g_pieceCount : 1 );
	g_crumbleInterval = (uint32_t)( interval < 4 ? 4 : ( interval > 26 ? 26 : interval ) );
}

static void SpawnPoint( int level, int index, float* outX, float* outY, float* outZ )
{
	static const float dirs[MAX_PLAYERS][2] = {
		{ 1.0f, 0.0f },	  { -1.0f, 0.0f },		{ 0.0f, 1.0f },		  { 0.0f, -1.0f },
		{ 0.7071f, 0.7071f }, { -0.7071f, -0.7071f }, { 0.7071f, -0.7071f }, { -0.7071f, 0.7071f },
	};

	*outY = 0.0f;

	if ( level >= LEVEL_HANDMADE && level < LEVEL_CUSTOM && g_genSpawnCount > 0 )
	{
		int slot = index % g_genSpawnCount;
		*outX = g_genSpawns[slot][0] + 0.3f * (float)( index / g_genSpawnCount );
		*outY = g_genSpawns[slot][1];
		*outZ = g_genSpawns[slot][2];
		return;
	}

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
		*outX = 10.2f * ring[index][0];
		*outZ = 10.2f * ring[index][1];
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

	if ( level == LEVEL_CRUZ )
	{
		// Axis-aligned spawns: the diagonals are void on this layout.
		static const float axis[MAX_PLAYERS][2] = {
			{ 1.0f, 0.0f }, { -1.0f, 0.0f }, { 0.0f, 1.0f }, { 0.0f, -1.0f },
			{ 0.5f, 0.0f }, { -0.5f, 0.0f }, { 0.0f, 0.5f }, { 0.0f, -0.5f },
		};
		*outX = 7.5f * axis[index][0];
		*outZ = 7.5f * axis[index][1];
		return;
	}

	if ( level == LEVEL_CALLES )
	{
		// Side-street tiles: on the lattice but OFF the boost avenues.
		static const float street[MAX_PLAYERS][2] = {
			{ 12.0f, 4.5f }, { -12.0f, -4.5f }, { -4.5f, 12.0f }, { 4.5f, -12.0f },
			{ 12.0f, -4.5f }, { -12.0f, 4.5f }, { 4.5f, 12.0f },  { -4.5f, -12.0f },
		};
		*outX = street[index][0];
		*outZ = street[index][1];
		return;
	}

	if ( level == LEVEL_ASPAS )
	{
		// Everyone starts inside the safe hub.
		*outX = 1.6f * dirs[index][0];
		*outZ = 1.6f * dirs[index][1];
		return;
	}

	if ( level == LEVEL_GEMELAS )
	{
		static const float twin[MAX_PLAYERS][2] = {
			{ -6.75f, 0.0f }, { 6.75f, 0.0f }, { -6.75f, 2.5f }, { 6.75f, -2.5f },
			{ -6.75f, -2.5f }, { 6.75f, 2.5f }, { -4.5f, 0.0f },  { 4.5f, 0.0f },
		};
		*outX = twin[index][0];
		*outZ = twin[index][1];
		return;
	}

	if ( level == LEVEL_PANAL )
	{
		static const float pads[MAX_PLAYERS][2] = {
			{ 9.0f, 9.0f }, { -9.0f, -9.0f }, { 9.0f, -9.0f }, { -9.0f, 9.0f },
			{ 9.0f, 0.0f }, { -9.0f, 0.0f },  { 0.0f, 9.0f },  { 0.0f, -9.0f },
		};
		*outX = pads[index][0];
		*outZ = pads[index][1];
		return;
	}

	if ( level == LEVEL_ZIGURAT )
	{
		// Axis spawns on the flat ground tier; extras on flat diagonal tiles
		// of the second terrace (the axis midlines are ramps).
		static const float zig[MAX_PLAYERS][3] = {
			{ 9.0f, 0.0f, 0.0f },	{ -9.0f, 0.0f, 0.0f },	 { 0.0f, 0.0f, 9.0f },	 { 0.0f, 0.0f, -9.0f },
			{ 4.5f, 1.6f, 4.5f }, { -4.5f, 1.6f, -4.5f }, { 4.5f, 1.6f, -4.5f }, { -4.5f, 1.6f, 4.5f },
		};
		*outX = zig[index][0];
		*outY = zig[index][1];
		*outZ = zig[index][2];
		return;
	}

	if ( level == LEVEL_TORRES )
	{
		static const float torres[MAX_PLAYERS][3] = {
			{ 9.75f, 1.6f, 0.0f }, { -9.75f, 1.6f, 0.0f }, { 0.0f, 0.0f, 3.0f }, { 0.0f, 0.0f, -3.0f },
			{ 4.5f, 0.0f, 4.5f },  { -4.5f, 0.0f, -4.5f }, { 4.5f, 0.0f, -4.5f }, { -4.5f, 0.0f, 4.5f },
		};
		*outX = torres[index][0];
		*outY = torres[index][1];
		*outZ = torres[index][2];
		return;
	}

	if ( level == LEVEL_FABRICA )
	{
		static const float fab[MAX_PLAYERS][2] = {
			{ 7.5f, 7.5f }, { -7.5f, -7.5f }, { 7.5f, -7.5f }, { -7.5f, 7.5f },
			{ 7.5f, 0.0f }, { -7.5f, 0.0f },  { 0.0f, 7.5f },  { 0.0f, -7.5f },
		};
		*outX = fab[index][0];
		*outZ = fab[index][1];
		return;
	}

	// Circular spawns; beam levels start on the diagonals so the arms
	// (along ±X at tick 0) miss everyone.
	bool diag = level == LEVEL_RULETA || level == LEVEL_RULETA2 || level == LEVEL_MARTILLO;
	int slot = diag ? ( index + 4 ) % MAX_PLAYERS : index;
	float radius = 4.9f;
	if ( level == LEVEL_CLASICA )
	{
		radius = 7.8f;
	}
	else if ( level == LEVEL_ANILLO )
	{
		// Inside the ring but OFF the boost lane (which spans r 9.6-11.2).
		radius = 7.8f;
	}
	else if ( level == LEVEL_RULETA )
	{
		radius = 8.9f;
	}
	else if ( level == LEVEL_DIANA )
	{
		radius = 12.4f;
	}
	else if ( level == LEVEL_VOLCAN )
	{
		radius = 10.4f;
	}
	else if ( level == LEVEL_RULETA2 )
	{
		radius = 6.2f;
	}
	else if ( level == LEVEL_MARTILLO )
	{
		radius = 8.0f;
	}
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
	g_mode = MODE_SUMO;
	g_modeParam = 0;
	g_zoneActive = false;
	g_zoneMoveAt = 0;
	g_cursed = -1;
	g_curseTicks = 0;
	g_curseImmunity = 0;
	memset( g_scores, 0, sizeof( g_scores ) );
	memset( g_inputs, 0, sizeof( g_inputs ) );
	memset( g_bots, 0, sizeof( g_bots ) );

	b3WorldDef worldDef = b3DefaultWorldDef();
	worldDef.gravity = ( b3Vec3 ){ 0.0f, -14.0f, 0.0f };
	worldDef.workerCount = 1;
	g_world = b3CreateWorld( &worldDef );

	b3BoxHull tileHull = b3MakeBoxHull( PIECE_HX, PIECE_HY, PIECE_HZ );
	g_genSpawnCount = 0;
	g_genBallR = PLAYER_RADIUS;
	if ( g_level == LEVEL_CUSTOM )
	{
		BuildCustomLevel( &tileHull );
	}
	else if ( g_level >= LEVEL_HANDMADE )
	{
		BuildGenerated( g_level, &tileHull );
		PickGeneratedSpawns();
	}
	else
	{
		BuildLevel( g_level, &tileHull );
	}
	g_standingPieces = g_pieceCount;

	// Each arena picks its ball size: tiny = nervous, huge = heavyweight sumo.
	static const float levelBallR[LEVEL_HANDMADE] = { 0.6f, 0.6f, 0.55f, 0.6f, 0.7f, 0.6f, 0.5f,	0.55f, 0.65f, 0.6f,
													  0.8f, 0.45f, 0.55f, 0.75f, 0.6f, 0.7f, 0.55f, 0.6f,  0.9f,  0.5f };
	float ballR = PLAYER_RADIUS;
	if ( g_level < LEVEL_HANDMADE )
	{
		ballR = levelBallR[g_level];
	}
	else if ( g_level < LEVEL_CUSTOM )
	{
		ballR = g_genBallR;
	}

	for ( int i = 0; i < g_playerCount; ++i )
	{
		float sx, sy, sz;
		SpawnPoint( g_level, i, &sx, &sy, &sz );

		b3BodyDef bodyDef = b3DefaultBodyDef();
		bodyDef.type = b3_dynamicBody;
		bodyDef.position = ( b3Pos ){ sx, sy + ballR + 0.05f, sz };
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
		b3Sphere sphere = { { 0.0f, 0.0f, 0.0f }, ballR };
		g_players[i].shape = b3CreateSphereShape( body, &shapeDef, &sphere );
		g_players[i].ballR = ballR;
		g_players[i].baseR = ballR;
		g_players[i].speedMult = 1.0f;

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

TUMBO_EXPORT void tumbo_set_mode( int mode, int param )
{
	g_mode = mode < 0 ? 0 : ( mode > MODE_MALDITO ? 0 : mode );
	g_modeParam = param < 1 ? 1 : param;
	if ( g_mode == MODE_MALDITO )
	{
		g_cursed = (int)( RngNext() % (uint32_t)g_playerCount );
		g_curseTicks = g_modeParam * 60;
		PushEvent( EVT_CURSE, 0.0f, 0.0f, 0.0f, (float)g_cursed, -1.0f );
	}
	if ( g_mode == MODE_COSECHA )
	{
		// Orbs matter from the first second.
		g_powerup.nextEventTick = COUNTDOWN_TICKS;
	}
	WriteState();
}

// ---------------------------------------------------------------------------
// Per-tick systems
// ---------------------------------------------------------------------------

static void PassCurse( int to, int from );
static int NearestAliveTo( float x, float z, int exclude );

static bool IsGrounded( const Player* p )
{
	b3Pos origin = b3Body_GetPosition( p->body );
	b3Vec3 translation = { 0.0f, -( p->ballR + 0.25f ), 0.0f };
	b3QueryFilter filter = b3DefaultQueryFilter();
	filter.maskBits = CAT_WORLD;
	b3RayResult result = b3World_CastRayClosest( g_world, origin, translation, filter );
	return result.hit;
}

// Index of the standing/warning tile under (x, z), or -1.
static int TileIndexAt( float x, float z )
{
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
			return i;
		}
	}
	return -1;
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

// `salt` de-clusters bots: without it every fleeing bot converges on the
// exact same "safest" tile and the fight collapses into a fixed-point scrum.
static void NearestSafeTile( float x, float z, int salt, float* outX, float* outZ )
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
		float score = dx * dx + dz * dz + 0.25f * ( ex * ex + ez * ez ) +
					  (float)( ( i * 7 + salt * 13 ) & 7 ) * 0.6f;
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

// Would a dash from `pos` toward (dirx, dirz) leave the bot over solid
// ground? A dash carries roughly 3.4m before friction wins.
static bool BotDashSafe( b3Pos pos, float dirx, float dirz )
{
	return SupportStateAt( pos.x + dirx * 3.4f, pos.z + dirz * 3.4f ) >= 1 ||
		   SupportStateAt( pos.x + dirx * 2.0f, pos.z + dirz * 2.0f ) >= 1;
}

static void BotReplan( int slot )
{
	Bot* bot = &g_bots[slot];
	Player* p = &g_players[slot];
	b3Pos pos = b3Body_GetPosition( p->body );

	bot->pulseDash = false;
	bot->pulseJump = false;

	// Stuck detection: barely moved since the last plan while touching rivals
	// means we're grinding in a scrum instead of playing.
	float movedX = pos.x - bot->lastX;
	float movedZ = pos.z - bot->lastZ;
	bool barelyMoved = movedX * movedX + movedZ * movedZ < 0.8f * 0.8f;
	int nearby = 0;
	for ( int j = 0; j < g_playerCount; ++j )
	{
		if ( j == slot || !g_players[j].alive )
		{
			continue;
		}
		b3Pos np = b3Body_GetPosition( g_players[j].body );
		float ndx = np.x - pos.x;
		float ndz = np.z - pos.z;
		if ( ndx * ndx + ndz * ndz < 1.9f * 1.9f )
		{
			nearby += 1;
		}
	}
	bot->stuck = ( barelyMoved && nearby > 0 ) ? bot->stuck + 1 : 0;
	bot->lastX = pos.x;
	bot->lastZ = pos.z;

	// Priority 1: don't be standing on doomed ground.
	if ( SupportStateAt( pos.x, pos.z ) < 2 )
	{
		NearestSafeTile( pos.x, pos.z, slot, &bot->tx, &bot->tz );
		if ( bot->difficulty >= 1 && p->jumpCooldown == 0 )
		{
			bot->pulseJump = true;
		}
		return;
	}

	// Mode-driven priorities override the default hunt.
	if ( g_mode == MODE_KOTH && g_zoneActive )
	{
		bot->tx = g_zoneX;
		bot->tz = g_zoneZ;
		int foe = NearestAliveTo( pos.x, pos.z, slot );
		if ( foe >= 0 && p->dashCooldown == 0 )
		{
			b3Pos fp = b3Body_GetPosition( g_players[foe].body );
			float fx = fp.x - pos.x;
			float fz = fp.z - pos.z;
			float fd = sqrtf( fx * fx + fz * fz );
			if ( fd < 2.4f && fd > 0.3f && BotDashSafe( pos, fx / fd, fz / fd ) )
			{
				bot->pulseDash = true;
			}
		}
		return;
	}
	if ( g_mode == MODE_COSECHA && g_powerup.active )
	{
		bot->tx = g_powerup.pos.x;
		bot->tz = g_powerup.pos.z;
		return;
	}
	if ( g_mode == MODE_MALDITO && g_cursed >= 0 && g_players[g_cursed].alive )
	{
		if ( slot == g_cursed )
		{
			int prey = NearestAliveTo( pos.x, pos.z, slot );
			if ( prey >= 0 )
			{
				b3Pos pp = b3Body_GetPosition( g_players[prey].body );
				bot->tx = pp.x;
				bot->tz = pp.z;
				float dx = pp.x - pos.x;
				float dz = pp.z - pos.z;
				float dd = sqrtf( dx * dx + dz * dz );
				if ( dd < 3.0f && dd > 0.3f && p->dashCooldown == 0 && BotDashSafe( pos, dx / dd, dz / dd ) )
				{
					bot->pulseDash = true;
				}
				return;
			}
		}
		else
		{
			b3Pos cp = b3Body_GetPosition( g_players[g_cursed].body );
			float dx = pos.x - cp.x;
			float dz = pos.z - cp.z;
			float d2c = dx * dx + dz * dz;
			if ( d2c < 5.0f * 5.0f && d2c > 0.01f )
			{
				// Run away, but toward safe ground.
				float d = sqrtf( d2c );
				NearestSafeTile( pos.x + dx / d * 4.0f, pos.z + dz / d * 4.0f, slot, &bot->tx, &bot->tz );
				return;
			}
		}
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

	// Priority 3: hunt a rival. A per-pair bias spreads the bots across
	// different victims instead of everyone dog-piling the same one.
	int target = -1;
	float bestScore = 1e30f;
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
		float score = d2 * ( 1.0f + 0.15f * (float)( ( slot * 5 + j * 3 ) & 3 ) );
		if ( score < bestScore )
		{
			bestScore = score;
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

	// Hard bots fight a half-step toward safety instead of squarely on the rim.
	if ( bot->difficulty == 2 )
	{
		float sx, sz;
		NearestSafeTile( pos.x, pos.z, slot, &sx, &sz );
		bot->tx += ( sx - bot->tx ) * 0.15f;
		bot->tz += ( sz - bot->tz ) * 0.15f;
	}

	float dist = sqrtf( bestD2 );

	// Dash only when the shove is worth it AND we won't fly off ourselves.
	// Easy bots skip the self-preservation check now and then — that's their charm.
	if ( p->dashCooldown == 0 && dist < 2.6f && dist > 0.3f )
	{
		float dirx = ( op.x - pos.x ) / dist;
		float dirz = ( op.z - pos.z ) / dist;
		bool lethal = SupportStateAt( op.x + dirx * 2.2f, op.z + dirz * 2.2f ) == 0;
		bool safe = BotDashSafe( pos, dirx, dirz ) || dist < 1.2f;
		if ( bot->difficulty == 0 )
		{
			safe = safe || ( BotRng() & 3u ) == 0u;
		}
		bool eager = bot->difficulty == 2 ? ( BotRng() % 3u ) != 0u : ( BotRng() & 3u ) == 0u;
		if ( safe && ( lethal || eager ) )
		{
			bot->pulseDash = true;
		}
	}

	// Sumo, not wrestling: chest-to-chest without attacking is wasted time
	// and it's how three bots end up grinding on one tile. Kite out, reset,
	// come back in swinging.
	if ( dist < 2.2f && !bot->pulseDash && dist > 0.01f )
	{
		float bx = ( pos.x - op.x ) / dist;
		float bz = ( pos.z - op.z ) / dist;
		float kx = pos.x + bx * 2.8f;
		float kz = pos.z + bz * 2.8f;
		if ( SupportStateAt( kx, kz ) >= 1 )
		{
			bot->tx = kx;
			bot->tz = kz;
		}
		else
		{
			NearestSafeTile( kx, kz, slot, &bot->tx, &bot->tz );
		}
		// A short brace still answers an incoming dash while backing off.
		if ( bot->difficulty >= 1 && g_players[target].dashCooldown > DASH_COOLDOWN_TICKS - DASH_HIT_WINDOW )
		{
			bot->braceFor = 10;
		}
		return;
	}

	// Scrum breaker: locked in a shoving match, either blast out with a
	// point-blank dash (only if WE land on solid ground) or flank sideways.
	if ( bot->stuck >= 3 && dist > 0.01f )
	{
		float dirx = ( op.x - pos.x ) / dist;
		float dirz = ( op.z - pos.z ) / dist;
		if ( p->dashCooldown == 0 && BotDashSafe( pos, dirx, dirz ) )
		{
			bot->pulseDash = true;
		}
		else
		{
			// Ground flank only: hopping mid-scrum leaves the bot airborne
			// and helpless right where the shoving is happening.
			float side = ( ( slot + (int)( g_frame / 90 ) ) & 1 ) ? 1.0f : -1.0f;
			float fxp = pos.x - dirz * 2.6f * side;
			float fzp = pos.z + dirx * 2.6f * side;
			if ( SupportStateAt( fxp, fzp ) >= 1 )
			{
				bot->tx = fxp;
				bot->tz = fzp;
			}
			else
			{
				NearestSafeTile( fxp, fzp, slot, &bot->tx, &bot->tz );
			}
		}
		return;
	}

	// Parry reaction (medium+): a SHORT brace against an incoming dash.
	// Holding it longer than the parry window just anchors the bot in place —
	// three bots doing that at each other is a deadlock, not a fight.
	if ( bot->difficulty >= 1 && nearby <= 1 && dist < 3.2f &&
		 g_players[target].dashCooldown > DASH_COOLDOWN_TICKS - DASH_HIT_WINDOW )
	{
		bot->braceFor = 10;
		bot->pulseDash = false;
	}
}

static void StepBots( void )
{
	if ( g_frame < COUNTDOWN_TICKS )
	{
		return;
	}

	// Per-difficulty tuning: think cadence, aim noise (applied at replan) and
	// how far ahead the bot projects its own momentum.
	static const int thinkBase[3] = { 18, 12, 8 };
	static const int thinkJitter[3] = { 7, 5, 3 };
	static const float aimNoise[3] = { 0.5f, 0.2f, 0.06f };
	static const float lookahead[3] = { 0.22f, 0.34f, 0.46f };

	for ( int i = 0; i < g_playerCount; ++i )
	{
		Bot* bot = &g_bots[i];
		if ( !bot->active || !g_players[i].alive )
		{
			continue;
		}

		int d = bot->difficulty;
		bot->think -= 1;
		if ( bot->think <= 0 )
		{
			BotReplan( i );
			// Aim noise once per plan: displace the target sideways a touch.
			float a = ( (float)( BotRng() % 1000u ) / 1000.0f - 0.5f ) * 2.0f * aimNoise[d];
			b3Pos ppos = b3Body_GetPosition( g_players[i].body );
			float ddx = bot->tx - ppos.x;
			float ddz = bot->tz - ppos.z;
			float ca = cosf( a );
			float sa = sinf( a );
			bot->tx = ppos.x + ddx * ca - ddz * sa;
			bot->tz = ppos.z + ddx * sa + ddz * ca;
			bot->think = thinkBase[d] + (int)( BotRng() % (uint32_t)( thinkJitter[d] + 1 ) );
		}

		b3Pos pos = b3Body_GetPosition( g_players[i].body );
		b3Vec3 vel = b3Body_GetLinearVelocity( g_players[i].body );
		float speed2 = vel.x * vel.x + vel.z * vel.z;
		uint32_t word = 0;

		// Predicted velocity: standing on a boost pad accelerates us beyond
		// current momentum, so project that in before checking for the void.
		float pvx = vel.x;
		float pvz = vel.z;
		int under = TileIndexAt( pos.x, pos.z );
		if ( under >= 0 && g_pieces[under].special == SPECIAL_BOOST )
		{
			pvx += g_pieces[under].dirX * 3.0f;
			pvz += g_pieces[under].dirZ * 3.0f;
			speed2 = pvx * pvx + pvz * pvz;
		}

		// EMERGENCY: our own momentum is carrying us over the void. Brake
		// before anything else — this is what keeps bots alive.
		float fx = pos.x + pvx * lookahead[d];
		float fz = pos.z + pvz * lookahead[d];
		bool slidingToVoid = speed2 > 3.0f && SupportStateAt( fx, fz ) == 0 && SupportStateAt( pos.x, pos.z ) >= 1;

		// ...unless there is ground beyond the gap and we can jump it.
		if ( slidingToVoid && speed2 > 16.0f && g_players[i].jumpCooldown == 0 )
		{
			float sp = sqrtf( speed2 );
			float jx = pos.x + pvx / sp * 3.4f;
			float jz = pos.z + pvz / sp * 3.4f;
			if ( SupportStateAt( jx, jz ) >= 1 )
			{
				word |= IN_JUMP;
				slidingToVoid = false;
			}
		}

		if ( slidingToVoid )
		{
			if ( d >= 1 )
			{
				// Brace is a handbrake: kills momentum in a few ticks.
				word = IN_BRACE;
			}
			else
			{
				// Easy bots just paddle against their velocity.
				if ( vel.z > 0.5f ) word |= IN_UP;
				if ( vel.z < -0.5f ) word |= IN_DOWN;
				if ( vel.x > 0.5f ) word |= IN_LEFT;
				if ( vel.x < -0.5f ) word |= IN_RIGHT;
			}
			g_inputs[i] = word;
			continue;
		}

		float dx = bot->tx - pos.x;
		float dz = bot->tz - pos.z;
		float dist = sqrtf( dx * dx + dz * dz );

		if ( dist > 0.25f )
		{
			dx /= dist;
			dz /= dist;

			// Arrive steering: chase a desired VELOCITY, not a position, so
			// the bot brakes into targets instead of flying past them.
			float desired = 1.8f * dist + 0.8f;
			if ( desired > MAX_MOVE_SPEED )
			{
				desired = MAX_MOVE_SPEED;
			}
			float sx = dx * desired - vel.x;
			float sz = dz * desired - vel.z;
			float sl = sqrtf( sx * sx + sz * sz );
			if ( sl > 0.6f )
			{
				sx /= sl;
				sz /= sl;
				if ( sz < -0.38f ) word |= IN_UP;
				if ( sz > 0.38f ) word |= IN_DOWN;
				if ( sx < -0.38f ) word |= IN_LEFT;
				if ( sx > 0.38f ) word |= IN_RIGHT;
			}

			// Gap ahead on the way to the target, solid ground past it: jump.
			if ( g_players[i].jumpCooldown == 0 && dist > 2.0f && SupportStateAt( pos.x + dx * 1.6f, pos.z + dz * 1.6f ) == 0 &&
				 SupportStateAt( pos.x + dx * 3.2f, pos.z + dz * 3.2f ) >= 1 )
			{
				word |= IN_JUMP;
			}
		}

		// Hazard dodging, every tick: jump over beam arms about to sweep
		// through, and hop away from pistons/orbiters closing in.
		if ( g_players[i].jumpCooldown == 0 )
		{
			for ( int hz = 0; hz < g_hazardCount; ++hz )
			{
				Hazard* h = &g_hazards[hz];
				if ( h->type == HAZARD_BEAM )
				{
					// Jump only when an arm actually arrives within ~0.35s —
					// hopping nonstop leaves the bot airborne and helpless.
					b3Vec3 av = b3Body_GetAngularVelocity( h->body );
					float w = av.y;
					if ( fabsf( w ) > 0.05f && pos.x * pos.x + pos.z * pos.z < h->halfExtents.x * h->halfExtents.x )
					{
						b3Quat q = b3Body_GetRotation( h->body );
						float yaw = 2.0f * atan2f( q.v.y, q.s );
						float mine = atan2f( pos.z, pos.x );
						float gap = ( mine - yaw ) * ( w > 0.0f ? 1.0f : -1.0f );
						gap = fmodf( gap + 31.4159265f, 3.14159265f ); // two arms, period pi
						if ( gap / fabsf( w ) < 0.35f )
						{
							word |= IN_JUMP;
						}
					}
				}
				else
				{
					b3Pos hp = b3Body_GetPosition( h->body );
					float rx = pos.x - hp.x;
					float rz = pos.z - hp.z;
					float reach = ( h->halfExtents.x > h->halfExtents.z ? h->halfExtents.x : h->halfExtents.z ) + 1.4f;
					if ( rx * rx + rz * rz < reach * reach )
					{
						b3Vec3 hv = b3Body_GetLinearVelocity( h->body );
						if ( hv.x * rx + hv.z * rz > 0.4f )
						{
							word |= IN_JUMP;
						}
					}
				}
			}
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
		// Short parry reaction beats everything else this tick.
		if ( bot->braceFor > 0 )
		{
			bot->braceFor -= 1;
			word = IN_BRACE;
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

		// Boost pads: the floor itself accelerates you (bracing opts out,
		// and nothing pushes helpless players during the countdown).
		if ( grounded && !frozen )
		{
			b3Pos bpos = b3Body_GetPosition( p->body );
			int ti = TileIndexAt( bpos.x, bpos.z );
			if ( ti >= 0 && g_pieces[ti].special == SPECIAL_BOOST )
			{
				b3Vec3 v = b3Body_GetLinearVelocity( p->body );
				if ( v.x * g_pieces[ti].dirX + v.z * g_pieces[ti].dirZ < BOOST_MAX_SPEED )
				{
					b3Vec3 f = { BOOST_ACCEL * mass * g_pieces[ti].dirX, 0.0f, BOOST_ACCEL * mass * g_pieces[ti].dirZ };
					b3Body_ApplyForceToCenter( p->body, f, true );
				}
			}
		}

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
			// TURBO pickups raise both the ceiling and the acceleration.
			if ( v.x * dx + v.z * dz < MAX_MOVE_SPEED * p->speedMult )
			{
				float accel = MOVE_ACCEL * p->speedMult * ( grounded ? 1.0f : AIR_CONTROL );
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
		g_powerup.type = ORB_SUPER;
		g_powerup.active = true;
		g_powerup.nextEventTick = g_frame + 600;
		PushEvent( EVT_ORB_SPAWN, g_powerup.pos.x, g_powerup.pos.y, g_powerup.pos.z, (float)ORB_SUPER, (float)vic );
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
			// Any solid contact passes the curse.
			if ( g_mode == MODE_MALDITO && g_curseImmunity == 0 && ( ia == g_cursed || ib == g_cursed ) )
			{
				int other = ia == g_cursed ? ib : ia;
				if ( g_players[other].alive && g_players[g_cursed].alive )
				{
					PassCurse( other, g_cursed );
				}
			}

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
				// Ramp the base speed up over time, keeping its sign.
				float mag = fabsf( h->a ) + 0.35f * (float)( t / 900 );
				if ( mag > 2.4f )
				{
					mag = 2.4f;
				}
				b3Body_SetAngularVelocity( h->body, ( b3Vec3 ){ 0.0f, h->a < 0.0f ? -mag : mag, 0.0f } );
			}
		}
		else if ( h->type == HAZARD_PISTON || h->type == HAZARD_PISTON_X )
		{
			uint32_t phase = ( t + (uint32_t)h->b ) % 280u;
			float v = phase < 140u ? h->a : -h->a;
			if ( h->type == HAZARD_PISTON )
			{
				b3Body_SetLinearVelocity( h->body, ( b3Vec3 ){ 0.0f, 0.0f, v } );
			}
			else
			{
				b3Body_SetLinearVelocity( h->body, ( b3Vec3 ){ v, 0.0f, 0.0f } );
			}
		}
		else if ( h->type == HAZARD_ORBITER )
		{
			// Chase the analytic orbit: velocity toward next tick's position
			// self-corrects any solver drift and stays deterministic.
			float angNext = h->b + h->a * ( (float)( t + 1u ) * TICK_DT );
			b3Pos pos = b3Body_GetPosition( h->body );
			float tx = cosf( angNext ) * h->c;
			float tz = sinf( angNext ) * h->c;
			b3Body_SetLinearVelocity( h->body, ( b3Vec3 ){ ( tx - pos.x ) / TICK_DT, 0.0f, ( tz - pos.z ) / TICK_DT } );
		}
	}
}

static void MoveZone( void )
{
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
		g_zoneX = tile.x;
		g_zoneZ = tile.z;
		g_zoneActive = true;
		PushEvent( EVT_ZONE, g_zoneX, tile.y + PIECE_HY, g_zoneZ, 0.0f, -1.0f );
	}
	g_zoneMoveAt = g_frame + ZONE_MOVE_TICKS;
}

static void PassCurse( int to, int from )
{
	g_cursed = to;
	g_curseImmunity = CURSE_IMMUNITY_TICKS;
	if ( to >= 0 )
	{
		b3Pos pos = b3Body_GetPosition( g_players[to].body );
		PushEvent( EVT_CURSE, pos.x, pos.y, pos.z, (float)to, (float)from );
	}
}

static int NearestAliveTo( float x, float z, int exclude )
{
	int best = -1;
	float bestD2 = 1e30f;
	for ( int i = 0; i < g_playerCount; ++i )
	{
		if ( i == exclude || !g_players[i].alive )
		{
			continue;
		}
		b3Pos op = b3Body_GetPosition( g_players[i].body );
		float dx = op.x - x;
		float dz = op.z - z;
		float d2 = dx * dx + dz * dz;
		if ( d2 < bestD2 )
		{
			bestD2 = d2;
			best = i;
		}
	}
	return best;
}

static void StepMode( void )
{
	if ( g_winner != -1 || g_frame < COUNTDOWN_TICKS )
	{
		return;
	}

	if ( g_mode == MODE_KOTH )
	{
		if ( !g_zoneActive || g_frame >= g_zoneMoveAt || SupportStateAt( g_zoneX, g_zoneZ ) != 2 )
		{
			MoveZone();
		}
		if ( !g_zoneActive )
		{
			return;
		}
		// Only an UNCONTESTED player scores.
		int inside = -1;
		int count = 0;
		for ( int i = 0; i < g_playerCount && count < 2; ++i )
		{
			if ( !g_players[i].alive )
			{
				continue;
			}
			b3Pos pos = b3Body_GetPosition( g_players[i].body );
			float dx = pos.x - g_zoneX;
			float dz = pos.z - g_zoneZ;
			if ( dx * dx + dz * dz < ZONE_RADIUS * ZONE_RADIUS && pos.y < 3.5f )
			{
				count += 1;
				inside = i;
			}
		}
		if ( count == 1 )
		{
			g_scores[inside] += 1;
			if ( g_scores[inside] % 60 == 0 )
			{
				b3Pos pos = b3Body_GetPosition( g_players[inside].body );
				PushEvent( EVT_MODE_POINT, pos.x, pos.y, pos.z, (float)inside, (float)( g_scores[inside] / 60 ) );
			}
			if ( g_scores[inside] >= g_modeParam * 60 )
			{
				g_winner = inside;
				PushEvent( EVT_ROUND_END, 0.0f, 0.0f, 0.0f, (float)g_winner, -1.0f );
			}
		}
	}
	else if ( g_mode == MODE_MALDITO )
	{
		if ( g_curseImmunity > 0 )
		{
			g_curseImmunity -= 1;
		}
		if ( g_cursed < 0 )
		{
			return;
		}
		if ( !g_players[g_cursed].alive )
		{
			// The cursed one fell on their own: the curse finds a new home.
			b3Pos last = b3Body_GetPosition( g_players[g_cursed].body );
			g_curseTicks = g_modeParam * 60;
			PassCurse( NearestAliveTo( last.x, last.z, g_cursed ), g_cursed );
			return;
		}
		g_curseTicks -= 1;
		if ( g_curseTicks <= 0 )
		{
			// Boom: the cursed player explodes, shoving everyone nearby.
			Player* victim = &g_players[g_cursed];
			b3Pos pos = b3Body_GetPosition( victim->body );
			for ( int i = 0; i < g_playerCount; ++i )
			{
				if ( i == g_cursed || !g_players[i].alive )
				{
					continue;
				}
				b3Pos op = b3Body_GetPosition( g_players[i].body );
				float dx = op.x - pos.x;
				float dz = op.z - pos.z;
				float d = sqrtf( dx * dx + dz * dz );
				if ( d < 4.0f && d > 0.01f )
				{
					float mass = b3Body_GetMass( g_players[i].body );
					float k = 7.0f * mass * ( 1.0f - d / 4.0f );
					b3Body_ApplyLinearImpulseToCenter( g_players[i].body,
													   ( b3Vec3 ){ dx / d * k, 0.4f * k, dz / d * k }, true );
				}
			}
			victim->alive = false;
			PushEvent( EVT_HIT, pos.x, pos.y, pos.z, 12.0f, (float)g_cursed );
			PushEvent( EVT_FALL, pos.x, pos.y, pos.z, 0.0f, (float)g_cursed );
			b3Body_Disable( victim->body );
			g_curseTicks = g_modeParam * 60;
			PassCurse( NearestAliveTo( pos.x, pos.z, g_cursed ), g_cursed );
		}
	}
}

// MEGA pickup: grow the ball by recreating its collision shape. Mass scales
// with r³ automatically (constant density), so bigger really is heavier.
static void ApplyMega( Player* p )
{
	float cap = p->baseR * MEGA_MAX;
	float nr = p->ballR * MEGA_STEP;
	if ( nr > cap )
	{
		nr = cap;
	}
	if ( nr <= p->ballR )
	{
		return;
	}
	p->ballR = nr;
	b3DestroyShape( p->shape, true );
	b3ShapeDef shapeDef = b3DefaultShapeDef();
	shapeDef.density = 1000.0f;
	shapeDef.baseMaterial.friction = 0.4f;
	shapeDef.baseMaterial.restitution = 0.55f;
	shapeDef.baseMaterial.rollingResistance = 0.03f;
	shapeDef.filter.categoryBits = CAT_PLAYER;
	shapeDef.enableHitEvents = true;
	b3Sphere sphere = { { 0.0f, 0.0f, 0.0f }, p->ballR };
	p->shape = b3CreateSphereShape( p->body, &shapeDef, &sphere );
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
			g_powerup.type = (int)( RngNext() % 3u );
			g_powerup.active = true;
			PushEvent( EVT_ORB_SPAWN, g_powerup.pos.x, g_powerup.pos.y, g_powerup.pos.z, (float)g_powerup.type, -1.0f );
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
			// Bomberman rules: what you grab changes how you roll.
			if ( g_powerup.type == ORB_TURBO )
			{
				p->speedMult = p->speedMult + TURBO_STEP > TURBO_MAX ? TURBO_MAX : p->speedMult + TURBO_STEP;
			}
			else if ( g_powerup.type == ORB_MEGA )
			{
				ApplyMega( p );
			}
			else
			{
				p->hasPower = true;
			}
			g_powerup.active = false;
			g_powerup.nextEventTick = g_frame + ( g_mode == MODE_COSECHA ? 120 : 300 );
			PushEvent( EVT_ORB_PICKUP, g_powerup.pos.x, g_powerup.pos.y, g_powerup.pos.z, (float)g_powerup.type,
					   (float)i );
			if ( g_mode == MODE_COSECHA && g_winner == -1 )
			{
				g_scores[i] += 1;
				PushEvent( EVT_MODE_POINT, g_powerup.pos.x, g_powerup.pos.y, g_powerup.pos.z, (float)i,
						   (float)g_scores[i] );
				if ( g_scores[i] >= g_modeParam )
				{
					g_winner = i;
					PushEvent( EVT_ROUND_END, 0.0f, 0.0f, 0.0f, (float)g_winner, -1.0f );
				}
			}
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
	StepMode();

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
