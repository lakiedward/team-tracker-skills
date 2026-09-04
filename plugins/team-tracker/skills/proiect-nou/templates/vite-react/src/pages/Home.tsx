import { Button, Section } from '../components/ui';

export function Home() {
  return (
    <main className="min-h-dvh bg-bg font-sans text-text">
      <Section
        stableKey="{{CODEBASE}}:section:hero:{{CODEBASE}}:page:/"
        title="{{PROJECT_NAME}}"
        description="Schelet creat de /proiect-nou. Prima sesiune de construcție înlocuiește secțiunea asta cu cele din UI Coverage."
      >
        <Button>Începe</Button>
      </Section>
    </main>
  );
}
