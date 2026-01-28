import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";

// GET /api/dismissed-threads - List all dismissed threads
export async function GET() {
  try {
    const dismissed = await db
      .select()
      .from(schema.dismissedThreads)
      .orderBy(schema.dismissedThreads.dismissedAt);

    return NextResponse.json(dismissed);
  } catch (error) {
    console.error("Error fetching dismissed threads:", error);
    return NextResponse.json(
      { error: "Failed to fetch dismissed threads" },
      { status: 500 }
    );
  }
}

// DELETE /api/dismissed-threads - Un-dismiss a thread by threadKey
export async function DELETE(request: NextRequest) {
  try {
    const { threadKey } = await request.json();

    if (!threadKey) {
      return NextResponse.json(
        { error: "threadKey is required" },
        { status: 400 }
      );
    }

    // Remove from dismissed_threads
    const result = await db
      .delete(schema.dismissedThreads)
      .where(eq(schema.dismissedThreads.threadKey, threadKey))
      .returning();

    if (result.length === 0) {
      return NextResponse.json(
        { error: "Thread not found in dismissed list" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      undismissed: result[0],
    });
  } catch (error) {
    console.error("Error un-dismissing thread:", error);
    return NextResponse.json(
      { error: "Failed to un-dismiss thread" },
      { status: 500 }
    );
  }
}
