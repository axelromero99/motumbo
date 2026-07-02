// TUMBO — deterministic sumo-arena simulation core.
// Everything gameplay-related lives here, in C, compiled to WASM.
// JS only writes packed inputs and reads the state buffer, so lockstep
// peers stay bit-identical as long as they feed the same inputs.

#include <box3d/box3d.h>
#include <stdint.h>
#include <string.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define TUMBO_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define TUMBO_EXPORT
#endif

#define MAX_PLAYERS 8
#define MAX_PIECES 128
#define MAX_HAZARDS 2
#define LEVEL_COUNT 4

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

// State buffer layout (floats):
//   header[8]: frame, aliveMask, playerCount, pieceCount, winner, levelId, hazardCount, powerupActive
//   per player[8]:  x y z qx qy qz qw flags   (flags: 1 alive, 2 dash ready, 4 has power)
//   per piece[8]:   x y z qx qy qz qw state   (0 gone, 1 static, 2 falling, 3 warning)
//   per hazard[12]: x y z qx qy qz qw sx sy sz type reserved
//   powerup[4]:     x y z active
#define STATE_HEADER 8
#define STATE_STRIDE 8
#define HAZARD_STRIDE 12

enum
{
	PIECE_GONE = 0,
	PIECE_STATIC = 1,
	PIECE_FALLING = 2,
	PIECE_WARNING = 3,
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
	EVT_ORB_SPAWN = 6,	 //
	EVT_ORB_PICKUP = 7,	 // b = player index
	EVT_ROUND_END = 8,	 // a = winner (-2 draw)
};

#define MAX_EVENTS 32
#define EVENT_FLOATS 6

enum
{
	LEVEL_CLASICA = 0,
	LEVEL_ANILLO = 1,
	LEVEL_PUENTES = 2,
	LEVEL_RULETA = 3,
};

typedef struct Player
{
	b3BodyId body;
	b3Vec3 facing;
	int dashCooldown;
	int jumpCooldown;
	bool hasPower;
	bool alive;
} Player;

typedef struct Piece
{
	b3BodyId body;
	int state;
	int timer;		// ticks left in WARNING before dropping
	int priority;	// crumble group, lower falls first
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

static b3WorldId g_world;
static Player g_players[MAX_PLAYERS];
static Piece g_pieces[MAX_PIECES];
static Hazard g_hazards[MAX_HAZARDS];
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

// PCG32 — deterministic RNG (crumble shuffle, power-up placement).
static uint64_t g_rngState;

static uint32_t RngNext( void )
{
	uint64_t old = g_rngState;
	g_rngState = old * 6364136223846793005ULL + 1442695040888963407ULL;
	uint32_t xorshifted = (uint32_t)( ( ( old >> 18u ) ^ old ) >> 27u );
	uint32_t rot = (uint32_t)( old >> 59u );
	return ( xorshifted >> rot ) | ( xorshifted << ( ( 32u - rot ) & 31u ) );
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
		int flags = ( p->alive ? 1 : 0 ) | ( p->dashCooldown == 0 ? 2 : 0 ) | ( p->hasPower ? 4 : 0 );
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

static void AddPiece( float cx, float cz, int priority, const b3BoxHull* hull )
{
	if ( g_pieceCount >= MAX_PIECES )
	{
		return;
	}

	b3BodyDef bodyDef = b3DefaultBodyDef();
	bodyDef.type = b3_staticBody;
	bodyDef.position = ( b3Pos ){ cx, -PIECE_HY, cz };
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

static void AddBeamHazard( float halfLength, float angularSpeed )
{
	b3BodyDef bodyDef = b3DefaultBodyDef();
	bodyDef.type = b3_kinematicBody;
	bodyDef.position = ( b3Pos ){ 0.0f, 0.95f, 0.0f };
	bodyDef.angularVelocity = ( b3Vec3 ){ 0.0f, angularSpeed, 0.0f };
	bodyDef.enableSleep = false;
	b3BodyId body = b3CreateBody( g_world, &bodyDef );

	b3Vec3 halfExtents = { halfLength, 0.3f, 0.32f };
	b3BoxHull hull = b3MakeBoxHull( halfExtents.x, halfExtents.y, halfExtents.z );
	b3ShapeDef shapeDef = b3DefaultShapeDef();
	shapeDef.baseMaterial.friction = 0.2f;
	shapeDef.baseMaterial.restitution = 0.4f;
	shapeDef.density = 2000.0f;
	shapeDef.filter.categoryBits = CAT_WORLD;
	b3CreateHullShape( body, &shapeDef, &hull.base );

	g_hazards[g_hazardCount].body = body;
	g_hazards[g_hazardCount].halfExtents = halfExtents;
	g_hazards[g_hazardCount].type = 0;
	g_hazardCount += 1;
}

static void BuildLevel( int level, const b3BoxHull* hull )
{
	int extent = 6;
	for ( int gx = -extent; gx <= extent; ++gx )
	{
		for ( int gz = -extent; gz <= extent; ++gz )
		{
			float cx = gx * PIECE_STEP;
			float cz = gz * PIECE_STEP;
			float d2 = cx * cx + cz * cz;

			if ( level == LEVEL_CLASICA )
			{
				if ( d2 <= 6.0f * 6.0f )
				{
					AddPiece( cx, cz, 0, hull );
				}
			}
			else if ( level == LEVEL_ANILLO )
			{
				if ( d2 <= 7.2f * 7.2f && d2 >= 2.9f * 2.9f )
				{
					AddPiece( cx, cz, 0, hull );
				}
			}
			else if ( level == LEVEL_PUENTES )
			{
				float dc2[4];
				dc2[0] = ( cx - 6.0f ) * ( cx - 6.0f ) + cz * cz;
				dc2[1] = ( cx + 6.0f ) * ( cx + 6.0f ) + cz * cz;
				dc2[2] = cx * cx + ( cz - 6.0f ) * ( cz - 6.0f );
				dc2[3] = cx * cx + ( cz + 6.0f ) * ( cz + 6.0f );
				float islandR2 = 2.0f * 2.0f;
				bool inIsland = dc2[0] <= islandR2 || dc2[1] <= islandR2 || dc2[2] <= islandR2 || dc2[3] <= islandR2;
				bool inCenter = d2 <= 2.3f * 2.3f;
				bool onBridge = ( gz == 0 || gx == 0 ) && d2 <= 6.0f * 6.0f;

				if ( inCenter )
				{
					AddPiece( cx, cz, d2 > 1.4f * 1.4f ? 3 : 4, hull );
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
					AddPiece( cx, cz, best > 1.3f * 1.3f ? 1 : 2, hull );
				}
				else if ( onBridge )
				{
					AddPiece( cx, cz, 0, hull );
				}
			}
			else // LEVEL_RULETA
			{
				if ( d2 <= 6.5f * 6.5f )
				{
					AddPiece( cx, cz, 0, hull );
				}
			}
		}
	}

	if ( level == LEVEL_RULETA )
	{
		ShuffleCrumbleOrder();
		AddBeamHazard( 5.8f, 0.9f );
		g_crumbleStart = 420;
		g_crumbleInterval = 35;
	}
	else
	{
		SortCrumbleOrder();
		g_crumbleStart = level == LEVEL_PUENTES ? 480 : 600;
		g_crumbleInterval = level == LEVEL_PUENTES ? 40 : 50;
	}
}

static void SpawnPoint( int level, int index, float* outX, float* outZ )
{
	static const float dirs[MAX_PLAYERS][2] = {
		{ 1.0f, 0.0f },	  { -1.0f, 0.0f },		{ 0.0f, 1.0f },		  { 0.0f, -1.0f },
		{ 0.7071f, 0.7071f }, { -0.7071f, -0.7071f }, { 0.7071f, -0.7071f }, { -0.7071f, 0.7071f },
	};

	if ( level == LEVEL_PUENTES )
	{
		// First four on the island centers, extras on the center plaza.
		if ( index < 4 )
		{
			*outX = 6.0f * dirs[index][0];
			*outZ = 6.0f * dirs[index][1];
		}
		else
		{
			*outX = 1.5f * dirs[index][0];
			*outZ = 1.5f * dirs[index][1];
		}
		return;
	}

	// Ruleta spawns on diagonals so the beam (along +X) misses at tick 0.
	int slot = level == LEVEL_RULETA ? ( index + 4 ) % MAX_PLAYERS : index;
	float radius = level == LEVEL_ANILLO ? 5.05f : ( level == LEVEL_RULETA ? 4.0f : 3.5f );
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
	g_frame = 0;
	g_winner = -1;
	g_crumbleNext = 0;
	g_pieceCount = 0;
	g_hazardCount = 0;
	g_level = level < 0 ? 0 : ( level >= LEVEL_COUNT ? LEVEL_COUNT - 1 : level );
	g_playerCount = playerCount < 1 ? 1 : ( playerCount > MAX_PLAYERS ? MAX_PLAYERS : playerCount );
	g_powerup.active = false;
	g_powerup.pos = ( b3Vec3 ){ 0.0f, -100.0f, 0.0f };
	g_powerup.nextEventTick = 240;
	memset( g_inputs, 0, sizeof( g_inputs ) );

	b3WorldDef worldDef = b3DefaultWorldDef();
	worldDef.gravity = ( b3Vec3 ){ 0.0f, -14.0f, 0.0f };
	worldDef.workerCount = 1;
	g_world = b3CreateWorld( &worldDef );

	b3BoxHull tileHull = b3MakeBoxHull( PIECE_HX, PIECE_HY, PIECE_HZ );
	BuildLevel( g_level, &tileHull );
	g_standingPieces = g_pieceCount;

	for ( int i = 0; i < g_playerCount; ++i )
	{
		float sx, sz;
		SpawnPoint( g_level, i, &sx, &sz );

		b3BodyDef bodyDef = b3DefaultBodyDef();
		bodyDef.type = b3_dynamicBody;
		bodyDef.position = ( b3Pos ){ sx, PLAYER_RADIUS + 0.05f, sz };
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
		g_players[i].dashCooldown = 0;
		g_players[i].jumpCooldown = 0;
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
		float dx = ( ( in & IN_RIGHT ) ? 1.0f : 0.0f ) - ( ( in & IN_LEFT ) ? 1.0f : 0.0f );
		float dz = ( ( in & IN_DOWN ) ? 1.0f : 0.0f ) - ( ( in & IN_UP ) ? 1.0f : 0.0f );
		if ( dx != 0.0f && dz != 0.0f )
		{
			dx *= 0.7071f;
			dz *= 0.7071f;
		}

		float mass = b3Body_GetMass( p->body );
		bool grounded = IsGrounded( p );

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

		if ( p->jumpCooldown > 0 )
		{
			p->jumpCooldown -= 1;
		}
		else if ( ( in & IN_JUMP ) && grounded )
		{
			b3Vec3 v = b3Body_GetLinearVelocity( p->body );
			if ( v.y <= 3.0f )
			{
				b3Vec3 impulse = { 0.0f, JUMP_SPEED * mass, 0.0f };
				b3Body_ApplyLinearImpulseToCenter( p->body, impulse, true );
				p->jumpCooldown = JUMP_COOLDOWN_TICKS;
				b3Pos pos = b3Body_GetPosition( p->body );
				PushEvent( EVT_JUMP, pos.x, pos.y, pos.z, 0.0f, (float)i );
			}
		}

		if ( p->dashCooldown > 0 )
		{
			p->dashCooldown -= 1;
		}
		else if ( in & IN_DASH )
		{
			bool powered = p->hasPower;
			float mult = powered ? POWER_DASH_MULT : 1.0f;
			p->hasPower = false;
			b3Vec3 impulse = { DASH_SPEED * mult * mass * p->facing.x, 0.0f, DASH_SPEED * mult * mass * p->facing.z };
			b3Body_ApplyLinearImpulseToCenter( p->body, impulse, true );
			p->dashCooldown = DASH_COOLDOWN_TICKS;
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

// Read Box3D hit events: emit feedback events and give recent dashers extra
// knockback so a well-timed dash launches the victim.
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
			// Normal points from A to B. Add a small upward pop for drama.
			if ( dashA && !dashB && g_players[ib].alive )
			{
				float mass = b3Body_GetMass( g_players[ib].body );
				float k = DASH_HIT_KNOCKBACK * hit->approachSpeed * mass;
				b3Vec3 impulse = { hit->normal.x * k, 0.3f * k, hit->normal.z * k };
				b3Body_ApplyLinearImpulseToCenter( g_players[ib].body, impulse, true );
			}
			else if ( dashB && !dashA && g_players[ia].alive )
			{
				float mass = b3Body_GetMass( g_players[ia].body );
				float k = DASH_HIT_KNOCKBACK * hit->approachSpeed * mass;
				b3Vec3 impulse = { -hit->normal.x * k, 0.3f * k, -hit->normal.z * k };
				b3Body_ApplyLinearImpulseToCenter( g_players[ia].body, impulse, true );
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

static void StepHazards( void )
{
	if ( g_level == LEVEL_RULETA && g_hazardCount > 0 && g_frame > 0 && g_frame % 900 == 0 )
	{
		float speed = 0.9f + 0.35f * (float)( g_frame / 900 );
		if ( speed > 2.3f )
		{
			speed = 2.3f;
		}
		b3Body_SetAngularVelocity( g_hazards[0].body, ( b3Vec3 ){ 0.0f, speed, 0.0f } );
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
			g_powerup.pos = ( b3Vec3 ){ tile.x, 1.1f, tile.z };
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
