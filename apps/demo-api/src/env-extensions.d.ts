interface Env {
  SECRET_HASH_KEY: string;
  TRIP_QUOTA?: string;
  TRAVEL_DAY_QUOTA?: string;
  PLACE_VISIT_QUOTA?: string;
  MEMORY_QUOTA?: string;
  DAY_REFLECTION_QUOTA?: string;
  TEST_BEHAVIOR_QUOTA?: string;
}

declare namespace Cloudflare {
  interface Env {
    SECRET_HASH_KEY: string;
    TRIP_QUOTA?: string;
    TRAVEL_DAY_QUOTA?: string;
    PLACE_VISIT_QUOTA?: string;
    MEMORY_QUOTA?: string;
    DAY_REFLECTION_QUOTA?: string;
    TEST_BEHAVIOR_QUOTA?: string;
  }
}
