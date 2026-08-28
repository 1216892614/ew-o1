import logoUrl from "@/client/assets/logo-64.png";

export function Header() {
  return (
    <header className="flex items-center gap-3 px-4 py-2 border-b border-base-300 bg-base-100/80 backdrop-blur-sm sticky top-0 z-50">
      <a href="/" className="flex items-center gap-2 no-underline">
        <img
          src={logoUrl}
          alt="EW-O1 Logo"
          width={32}
          height={32}
          className="rounded"
        />
        <span className="text-lg font-semibold text-base-content">EW-O1</span>
      </a>
    </header>
  );
}
