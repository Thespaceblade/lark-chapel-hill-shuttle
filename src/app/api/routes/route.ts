import { NextResponse } from "next/server";
import routesData from "../../../../data/intended_routes.json";
import { SHUTTLES } from "@/lib/shuttles";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    generatedAt: (routesData as { generated_at?: string }).generated_at ?? null,
    express: {
      color: SHUTTLES.express.color,
      stops: (routesData as { express: { stops: unknown; line: unknown } }).express
        .stops,
      line: (routesData as { express: { line: unknown } }).express.line,
    },
    regular: {
      color: SHUTTLES.regular.color,
      stops: (routesData as { regular: { stops: unknown; line: unknown } }).regular
        .stops,
      line: (routesData as { regular: { line: unknown } }).regular.line,
    },
  });
}
