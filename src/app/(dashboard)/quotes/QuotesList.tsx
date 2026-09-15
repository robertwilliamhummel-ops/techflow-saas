"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { limit, orderBy, where } from "firebase/firestore";
import { Plus, Search } from "lucide-react";
import * as Sentry from "@sentry/nextjs";

import { QuoteTable, type QuoteWithId } from "@/components/quotes/QuoteTable";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { localIsoDate } from "@/lib/invoices/dueStatus";
import {
  QUOTE_LIST_FILTERS,
  matchesQuoteSearch,
  quoteFilterFor,
  quoteFilterHref,
  type QuoteListFilter,
} from "@/lib/quotes/quoteStatus";
import { useTenantContext } from "@/lib/tenant/TenantContext";
import { useTenantCollection } from "@/lib/tenant/useTenantCollection";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 50;

export function QuotesList() {
  const { hasFeature, loading } = useTenantContext();
  const searchParams = useSearchParams();
  const filter = quoteFilterFor(searchParams.get("status"));
  // Kept here so switching filters keeps the search.
  const [query, setQuery] = useState("");

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-2xl font-semibold">Quotes</h1>
        {!loading && hasFeature("quotes") ? (
          <Link href="/quotes/new" className={buttonVariants({ size: "lg" })}>
            <Plus data-icon="inline-start" aria-hidden />
            New quote
          </Link>
        ) : null}
      </div>

      {loading ? (
        <Skeleton className="h-96 rounded-xl" />
      ) : !hasFeature("quotes") ? (
        <Alert>
          <AlertTitle>Quotes are turned off for your account</AlertTitle>
          <AlertDescription>
            Contact TechFlow support to add quotes to your account.
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <nav aria-label="Filter by status" className="-mx-1 overflow-x-auto px-1">
              <ul className="flex gap-1">
                {QUOTE_LIST_FILTERS.map((item) => {
                  const active = item.key === filter.key;
                  return (
                    <li key={item.key} className="shrink-0">
                      <Link
                        href={quoteFilterHref(item.key)}
                        scroll={false}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "block rounded-md px-3 py-1.5 text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                          active
                            ? "bg-muted font-medium text-foreground"
                            : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                        )}
                      >
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>
            <div className="relative md:w-80">
              <Search
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id="quote-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Customer, email or quote number"
                aria-label="Search quotes"
                className="pl-8"
              />
            </div>
          </div>

          {/* A new filter is a new query: remount so paging starts over. */}
          <FilteredQuotes key={filter.key} filter={filter} query={query} onClearSearch={() => setQuery("")} />
        </>
      )}
    </div>
  );
}

function FilteredQuotes({
  filter,
  query,
  onClearSearch,
}: {
  filter: QuoteListFilter;
  query: string;
  onClearSearch: () => void;
}) {
  // Fixed for the life of the page — reload to roll over at midnight.
  const [today] = useState(() => localIsoDate(new Date()));
  const [pageLimit, setPageLimit] = useState(PAGE_SIZE);

  // Filtered queries use the quotes (status, createdAt desc) index, pinned by
  // functions/test/shared/firestoreIndexes.test.ts.
  const constraints = useMemo(
    () =>
      filter.statuses
        ? [
            where("status", "in", [...filter.statuses]),
            orderBy("createdAt", "desc"),
            limit(pageLimit),
          ]
        : [orderBy("createdAt", "desc"), limit(pageLimit)],
    [filter, pageLimit],
  );
  const { data, loading, error } = useTenantCollection<QuoteWithId>("quotes", constraints);

  useEffect(() => {
    if (error) Sentry.captureException(error);
  }, [error]);

  const rows = useMemo(() => data.filter((quote) => matchesQuoteSearch(quote, query)), [data, query]);
  const hasMore = data.length >= pageLimit;
  const searching = query.trim() !== "";

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t load your quotes</AlertTitle>
        <AlertDescription>Refresh the page to try again.</AlertDescription>
      </Alert>
    );
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        {loading ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          searching ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-sm text-muted-foreground">No quotes match your search.</p>
              <Button variant="outline" onClick={onClearSearch}>
                Clear search
              </Button>
            </div>
          ) : filter.key === "all" ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-sm text-muted-foreground">No quotes yet.</p>
              <Link href="/quotes/new" className={buttonVariants({ variant: "outline" })}>
                Create your first quote
              </Link>
            </div>
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No {filter.label.toLowerCase()} quotes.
            </p>
          )
        ) : (
          <QuoteTable quotes={rows} today={today} />
        )}

        {!loading && (hasMore || searching) ? (
          <div className="flex flex-col items-center gap-2 text-center">
            {searching && hasMore ? (
              <p className="text-xs text-muted-foreground">
                Search covers the {data.length} most recent quotes loaded. Load
                more to search older ones.
              </p>
            ) : null}
            {hasMore ? (
              <Button variant="outline" onClick={() => setPageLimit((current) => current + PAGE_SIZE)}>
                Load more
              </Button>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
