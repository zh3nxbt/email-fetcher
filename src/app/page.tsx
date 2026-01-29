"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, Loader2, Mail, FileText, Calendar, ChevronLeft, ChevronRight, Sun, Clock, Coffee } from "lucide-react";
import type { DailyReport } from "@/db/schema";

export default function Dashboard() {
  const [reports, setReports] = useState<DailyReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<"daily_summary" | "morning_reminder" | "midday_report">("daily_summary");
  const reportContainerRef = useRef<HTMLDivElement>(null);

  // Get unique dates from reports
  const availableDates = useMemo(() => {
    const dates = [...new Set(reports.map((r) => r.reportDate))].sort().reverse();
    return dates;
  }, [reports]);

  // Get reports for the selected date
  const reportsForDate = useMemo(() => {
    if (!selectedDate) return [];
    return reports.filter((r) => r.reportDate === selectedDate);
  }, [reports, selectedDate]);

  // Get available report types for selected date
  const availableTypes = useMemo(() => {
    return reportsForDate.map((r) => r.reportType);
  }, [reportsForDate]);

  // Get the currently displayed report
  const displayedReport = useMemo(() => {
    return reportsForDate.find((r) => r.reportType === selectedType) || reportsForDate[0] || null;
  }, [reportsForDate, selectedType]);

  const fetchReports = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch("/api/reports?limit=50");
      if (!response.ok) throw new Error("Failed to fetch reports");

      const data = await response.json();
      const fetchedReports = data.reports || [];
      setReports(fetchedReports);
      setError(null);

      // Auto-select the most recent date if none selected
      if (fetchedReports.length > 0 && !selectedDate) {
        const dates = [...new Set(fetchedReports.map((r: DailyReport) => r.reportDate))].sort().reverse();
        setSelectedDate(dates[0] as string);
      }
    } catch (err) {
      setError("Failed to load reports");
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [selectedDate]);

  const handleGenerateReport = async () => {
    setGenerating(true);
    setError(null);

    try {
      const response = await fetch("/api/generate-report", { method: "POST" });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Report generation failed");
      }
      await fetchReports();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Report generation failed");
      console.error(err);
    } finally {
      setGenerating(false);
    }
  };

  // Navigate to previous/next date
  const navigateDate = (direction: "prev" | "next") => {
    if (!selectedDate || availableDates.length === 0) return;
    const currentIndex = availableDates.indexOf(selectedDate);
    if (direction === "prev" && currentIndex < availableDates.length - 1) {
      setSelectedDate(availableDates[currentIndex + 1]);
    } else if (direction === "next" && currentIndex > 0) {
      setSelectedDate(availableDates[currentIndex - 1]);
    }
  };

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  // Handle clicks on "Mark Complete" buttons in the report HTML
  useEffect(() => {
    const container = reportContainerRef.current;
    if (!container || !displayedReport) return;

    // Show the complete buttons (hidden by default for email)
    const buttons = container.querySelectorAll<HTMLButtonElement>(".todo-complete-btn");
    buttons.forEach((btn) => {
      btn.style.display = "block";
    });

    const handleClick = async (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.classList.contains("todo-complete-btn") || target.hasAttribute("disabled")) {
        return;
      }

      const threadKey = target.getAttribute("data-thread-key");
      if (!threadKey) return;

      // Disable button and show loading state
      target.textContent = "Completing...";
      target.setAttribute("disabled", "true");

      try {
        const response = await fetch("/api/todos/resolve", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reportId: displayedReport.id,
            threadKey,
          }),
        });

        if (!response.ok) {
          throw new Error("Failed to mark as complete");
        }

        // Update the button to show completed state
        target.textContent = "Completed";
        target.classList.add("completed");

        // Update the parent todo-item to show resolved state
        const todoItem = target.closest(".todo-item");
        if (todoItem) {
          todoItem.classList.add("todo-resolved");
          const subject = todoItem.querySelector(".todo-subject");
          if (subject && !subject.querySelector(".resolved-tag")) {
            subject.insertAdjacentHTML("beforeend", '<span class="resolved-tag">resolved</span>');
          }
        }
      } catch (err) {
        console.error("Failed to mark todo as complete:", err);
        target.textContent = "Mark Complete";
        target.removeAttribute("disabled");
        setError("Failed to mark action item as complete");
      }
    };

    container.addEventListener("click", handleClick);
    return () => container.removeEventListener("click", handleClick);
  }, [displayedReport]);

  const formatDate = (dateStr: string | Date | null) => {
    if (!dateStr) return "Unknown";
    const date = new Date(dateStr + "T12:00:00"); // Add time to avoid timezone shift
    return date.toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const formatDateShort = (dateStr: string) => {
    const date = new Date(dateStr + "T12:00:00");
    return date.toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  };

  const formatTime = (dateStr: string | Date | null) => {
    if (!dateStr) return "";
    const date = new Date(dateStr);
    return date.toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  return (
    <main className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              Email Report Dashboard
            </h1>
            <p className="text-sm text-muted-foreground">
              Daily email summaries and action items
            </p>
          </div>
          <div className="flex items-center gap-4">
            <Button onClick={handleGenerateReport} disabled={generating}>
              {generating ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Generate Report
                </>
              )}
            </Button>
          </div>
        </div>
      </header>

      {/* Error banner */}
      {error && (
        <div className="bg-red-50 border-l-4 border-red-500 p-4 mx-6 mt-4 max-w-6xl mx-auto">
          <p className="text-red-700">{error}</p>
        </div>
      )}

      {/* Main content */}
      <div className="max-w-6xl mx-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : reports.length === 0 ? (
          <div className="text-center py-20">
            <FileText className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
            <h2 className="text-xl font-semibold mb-2">No Reports Yet</h2>
            <p className="text-muted-foreground mb-6">
              Run a report to generate your first daily summary.
            </p>
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Use the command line:
              </p>
              <code className="bg-gray-100 px-3 py-1 rounded text-sm">
                npm run report -- --skip-email
              </code>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Date Selector */}
            <div className="flex items-center justify-between bg-white rounded-lg border p-4">
              <Button
                variant="outline"
                size="icon"
                onClick={() => navigateDate("prev")}
                disabled={!selectedDate || availableDates.indexOf(selectedDate) >= availableDates.length - 1}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>

              <div className="flex items-center gap-4">
                <Calendar className="h-5 w-5 text-muted-foreground" />
                <select
                  value={selectedDate || ""}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  className="text-lg font-semibold bg-transparent border-none focus:outline-none cursor-pointer"
                >
                  {availableDates.map((date) => (
                    <option key={date} value={date}>
                      {formatDateShort(date)}
                    </option>
                  ))}
                </select>
              </div>

              <Button
                variant="outline"
                size="icon"
                onClick={() => navigateDate("next")}
                disabled={!selectedDate || availableDates.indexOf(selectedDate) <= 0}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>

            {/* Report Type Toggle */}
            {selectedDate && (
              <div className="flex gap-2">
                <Button
                  variant={selectedType === "morning_reminder" ? "default" : "outline"}
                  onClick={() => setSelectedType("morning_reminder")}
                  disabled={!availableTypes.includes("morning_reminder")}
                  className="flex-1"
                >
                  <Sun className="h-4 w-4 mr-2" />
                  7am
                  {!availableTypes.includes("morning_reminder") && (
                    <span className="ml-2 text-xs opacity-60">(none)</span>
                  )}
                </Button>
                <Button
                  variant={selectedType === "midday_report" ? "default" : "outline"}
                  onClick={() => setSelectedType("midday_report")}
                  disabled={!availableTypes.includes("midday_report")}
                  className="flex-1"
                >
                  <Coffee className="h-4 w-4 mr-2" />
                  12pm
                  {!availableTypes.includes("midday_report") && (
                    <span className="ml-2 text-xs opacity-60">(none)</span>
                  )}
                </Button>
                <Button
                  variant={selectedType === "daily_summary" ? "default" : "outline"}
                  onClick={() => setSelectedType("daily_summary")}
                  disabled={!availableTypes.includes("daily_summary")}
                  className="flex-1"
                >
                  <Clock className="h-4 w-4 mr-2" />
                  4pm
                  {!availableTypes.includes("daily_summary") && (
                    <span className="ml-2 text-xs opacity-60">(none)</span>
                  )}
                </Button>
              </div>
            )}

            {/* Report Display */}
            {displayedReport ? (
              <Card>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg">
                      {displayedReport.reportType === "daily_summary"
                        ? "Daily Summary"
                        : displayedReport.reportType === "midday_report"
                        ? "Midday Update"
                        : "Morning Reminder"}
                    </CardTitle>
                    <Badge variant={displayedReport.reportType === "daily_summary" ? "default" : "secondary"}>
                      {displayedReport.reportType === "daily_summary"
                        ? "4pm"
                        : displayedReport.reportType === "midday_report"
                        ? "12pm"
                        : "7am"}
                    </Badge>
                  </div>
                  <CardDescription>
                    Generated at {formatTime(displayedReport.generatedAt)}
                    {displayedReport.sentAt && ` • Sent at ${formatTime(displayedReport.sentAt)}`}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex gap-6 text-sm mb-4">
                    <div className="flex items-center gap-2">
                      <Mail className="h-4 w-4 text-green-600" />
                      <span>{displayedReport.emailsReceived} received</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Mail className="h-4 w-4 text-blue-600" />
                      <span>{displayedReport.emailsSent} sent</span>
                    </div>
                  </div>

                  {/* Inline Report HTML */}
                  {displayedReport.reportHtml ? (
                    <div
                      ref={reportContainerRef}
                      className="border rounded-lg overflow-hidden"
                      dangerouslySetInnerHTML={{ __html: displayedReport.reportHtml }}
                    />
                  ) : (
                    <p className="text-muted-foreground text-center py-8">
                      No HTML content available
                    </p>
                  )}
                </CardContent>
              </Card>
            ) : selectedDate ? (
              <div className="text-center py-12 text-muted-foreground">
                No report available for the selected type
              </div>
            ) : null}
          </div>
        )}
      </div>
    </main>
  );
}
