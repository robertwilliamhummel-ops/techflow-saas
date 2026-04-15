"use client";

import { notFound } from "next/navigation";
import { toast } from "sonner";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { computeForeground } from "@/lib/design/contrast";

if (process.env.NODE_ENV === "production") {
  notFound();
}

const SAMPLE_TENANT = {
  primaryColor: "#E11D48",
  secondaryColor: "#FEF3C7",
};

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold">{title}</h2>
      <div className="rounded-lg border bg-card p-6 text-card-foreground">
        {children}
      </div>
    </section>
  );
}

export default function StyleGuidePage() {
  return (
    <main className="mx-auto max-w-5xl space-y-10 p-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold">Style Guide</h1>
        <p className="text-muted-foreground">
          Dev-only primitive gallery. Hidden in production.
        </p>
      </header>

      <Section title="Buttons">
        <div className="flex flex-wrap gap-3">
          <Button>Default</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="link">Link</Button>
        </div>
      </Section>

      <Section title="Badges">
        <div className="flex flex-wrap gap-3">
          <Badge>Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="destructive">Destructive</Badge>
          <Badge variant="success">Success</Badge>
          <Badge variant="warning">Warning</Badge>
          <Badge variant="outline">Outline</Badge>
        </div>
      </Section>

      <Section title="Inputs">
        <div className="grid max-w-md gap-4">
          <div className="grid gap-2">
            <Label htmlFor="sg-email">Email</Label>
            <Input id="sg-email" type="email" placeholder="jane@example.com" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="sg-note">Note</Label>
            <Textarea id="sg-note" placeholder="Write something…" />
          </div>
          <div className="grid gap-2">
            <Label>Currency</Label>
            <Select>
              <SelectTrigger>
                <SelectValue placeholder="Pick a currency" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="CAD">CAD</SelectItem>
                <SelectItem value="USD">USD</SelectItem>
                <SelectItem value="EUR">EUR</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="sg-check" />
            <Label htmlFor="sg-check">Send receipt by email</Label>
          </div>
          <RadioGroup defaultValue="monthly">
            <div className="flex items-center gap-2">
              <RadioGroupItem id="sg-weekly" value="weekly" />
              <Label htmlFor="sg-weekly">Weekly</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem id="sg-monthly" value="monthly" />
              <Label htmlFor="sg-monthly">Monthly</Label>
            </div>
          </RadioGroup>
        </div>
      </Section>

      <Section title="Alerts">
        <div className="grid gap-3">
          <Alert>
            <AlertTitle>Heads up</AlertTitle>
            <AlertDescription>This is a default alert.</AlertDescription>
          </Alert>
          <Alert variant="destructive">
            <AlertTitle>Something broke</AlertTitle>
            <AlertDescription>Destructive variant.</AlertDescription>
          </Alert>
        </div>
      </Section>

      <Section title="Card">
        <Card>
          <CardHeader>
            <CardTitle>Invoice #INV-0001</CardTitle>
            <CardDescription>Due on Apr 30, 2026.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Card content renders inside a bordered surface.
            </p>
          </CardContent>
        </Card>
      </Section>

      <Section title="Dialogs">
        <div className="flex gap-3">
          <Dialog>
            <DialogTrigger className={buttonVariants({ variant: "outline" })}>
              Open dialog
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Dialog title</DialogTitle>
                <DialogDescription>
                  Standard modal dialog — focus trapped, ESC to close.
                </DialogDescription>
              </DialogHeader>
            </DialogContent>
          </Dialog>
          <AlertDialog>
            <AlertDialogTrigger
              className={buttonVariants({ variant: "destructive" })}
            >
              Delete invoice
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this invoice?</AlertDialogTitle>
                <AlertDialogDescription>
                  This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction>Delete</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </Section>

      <Section title="Toasts (Sonner)">
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => toast("Default toast")}>Default</Button>
          <Button
            variant="outline"
            onClick={() => toast.success("Saved successfully")}
          >
            Success
          </Button>
          <Button
            variant="destructive"
            onClick={() => toast.error("Something went wrong")}
          >
            Error
          </Button>
        </div>
      </Section>

      <Section title="Table">
        <Table>
          <TableCaption>Recent invoices</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Number</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>INV-0001</TableCell>
              <TableCell>Alice Chen</TableCell>
              <TableCell>
                <Badge variant="success">Paid</Badge>
              </TableCell>
              <TableCell className="text-right">$250.00</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>INV-0002</TableCell>
              <TableCell>Bob Patel</TableCell>
              <TableCell>
                <Badge variant="destructive">Overdue</Badge>
              </TableCell>
              <TableCell className="text-right">$1,100.00</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>INV-0003</TableCell>
              <TableCell>Carol Ng</TableCell>
              <TableCell>
                <Badge variant="outline">Draft</Badge>
              </TableCell>
              <TableCell className="text-right">$90.00</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Section>

      <Section title="Dropdown menu">
        <DropdownMenu>
          <DropdownMenuTrigger
            className={buttonVariants({ variant: "outline" })}
          >
            Row actions
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Edit</DropdownMenuItem>
            <DropdownMenuItem>Duplicate</DropdownMenuItem>
            <DropdownMenuItem className="text-destructive">
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Section>

      <Section title="Tabs">
        <Tabs defaultValue="general">
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="branding">Branding</TabsTrigger>
            <TabsTrigger value="billing">Billing</TabsTrigger>
          </TabsList>
          <TabsContent value="general">General settings.</TabsContent>
          <TabsContent value="branding">Branding settings.</TabsContent>
          <TabsContent value="billing">Billing settings.</TabsContent>
        </Tabs>
      </Section>

      <Section title="Skeleton">
        <div className="space-y-2">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </Section>

      <Section title="Separator">
        <div>
          Above
          <Separator className="my-4" />
          Below
        </div>
      </Section>

      <Section title="Tenant override preview">
        <p className="mb-4 text-sm text-muted-foreground">
          Sample tenant brand (#E11D48 primary / #FEF3C7 secondary) applied
          locally via inline CSS variables. Computed foregrounds keep text
          legible automatically.
        </p>
        <div
          className="rounded-lg border p-6"
          style={
            {
              "--primary": SAMPLE_TENANT.primaryColor,
              "--primary-foreground": computeForeground(
                SAMPLE_TENANT.primaryColor,
              ),
              "--secondary": SAMPLE_TENANT.secondaryColor,
              "--secondary-foreground": computeForeground(
                SAMPLE_TENANT.secondaryColor,
              ),
            } as React.CSSProperties
          }
        >
          <div className="flex flex-wrap gap-3">
            <Button>Primary CTA</Button>
            <Button variant="secondary">Secondary</Button>
            <Badge>Primary badge</Badge>
            <Badge variant="secondary">Secondary badge</Badge>
          </div>
        </div>
      </Section>
    </main>
  );
}
