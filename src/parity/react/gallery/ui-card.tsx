// src/client/components/ui/card.tsx, every block (gallery/ui-card.ts on the Foldkit side).
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../../../client/components/ui/card"

export default function CardGallery() {
  return (
    <div className="flex flex-col gap-4 bg-background p-4 text-foreground">
      <Card className="w-80 rounded-xl border border-border">
        <CardHeader>
          <CardTitle>Usage</CardTitle>
          <CardDescription>Five hours of Claude, resetting in 2h.</CardDescription>
        </CardHeader>
        <CardContent>Content goes here.</CardContent>
        <CardFooter className="justify-end">Footer</CardFooter>
      </Card>
      <Card>Bare card</Card>
    </div>
  )
}
