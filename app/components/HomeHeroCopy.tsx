import { HOME_HERO_LEDE } from '~/lib/trust';

// Block-art mascot for the terminal hero. Leading spaces do the aligning, so
// short rows need no trailing padding.
const GHOST_ASCII = [
  '    ████████',
  '  ████████████',
  ' ██████████████',
  '████████████████',
  '███    ██    ███',
  '███ ██ ██ ██ ███',
  '███ ██ ██ ██ ███',
  '███    ██    ███',
  '████████████████',
  '████████████████',
  '████████████████',
  '██ ████ ████ ███',
  '█  ███   ███  ██',
].join('\n');

export function HomeHeroCopy({ headingId, reveal = false }: { headingId: string; reveal?: boolean }) {
  return (
    <div className={reveal ? 'ghost-home-reveal' : undefined}>
      <pre className="ghost-home-ascii" aria-hidden="true">
        {GHOST_ASCII}
      </pre>
      <p className="ghost-home-beta">Public beta</p>
      <h1 id={headingId} className="ghost-home-title">
        If you can dream it,
        <br />
        <span>the ghost will build it.</span>
      </h1>
      <p className="ghost-home-lede">{HOME_HERO_LEDE}</p>
      <p className="ghost-home-ownership">Requires Cloudflare Workers Paid and Containers.</p>
    </div>
  );
}
