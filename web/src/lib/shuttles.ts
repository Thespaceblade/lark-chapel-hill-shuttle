export type ShuttleKey = "express" | "regular";

export type Stop = {
  key: string;
  name: string;
  lat: number;
  lon: number;
};

export type LiveShuttle = {
  key: ShuttleKey;
  name: string;
  vehicleNumber: string | null;
  state: string | null;
  speed: string | null;
  address: string | null;
  lat: number | null;
  lon: number | null;
  bearing: number | null;
  compass: string | null;
  locatedAt: string | null;
  mapsUrl: string | null;
  nextStop: {
    key: string;
    name: string;
    alongM: number;
    etaMin: number | null;
  } | null;
  loopFrac: number | null;
  offLoopM: number | null;
};

export const SHUTTLES: Record<
  ShuttleKey,
  { key: ShuttleKey; name: string; uuid: string; color: string }
> = {
  express: {
    key: "express",
    name: "Express",
    uuid: "0c5a01f2-a549-11f1-83ea-4247aa532d4a",
    color: "#1f6f8b",
  },
  regular: {
    key: "regular",
    name: "Regular",
    uuid: "2485bb70-a546-11f1-a663-320d2d4970d9",
    color: "#b35c1e",
  },
};

export const MOTIVE = {
  endpoint: "https://api.keeptruckin.com/api/s1/live_shares",
  apiKey: "3gCAa2VxLV3nlJfk7EhzJUEe5lg3IU9b50sNyOfUSSE6Fg2ACZr6GK5KqpMW55rn",
  userAgent: "lark-shuttle-web/0.1 (+vercel)",
};
