import React, { useMemo, useState } from "react";
import {
  Search,
  ChevronRight,
  Command,
  X,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";

/**
 * Sidebar de navegação principal do CRM — adaptada do componente de referência
 * (dashboard-sidebar.tsx) para o design system já existente no app (styles.css:
 * tokens --surface/--primary/--border/--text-muted, classes .badge etc.), em vez de
 * Tailwind/shadcn. Ver README do componente de origem para o desenho visual original.
 *
 * Diferenças em relação à versão original:
 *  - "Workspace switcher" virou um cabeçalho simples de marca (o CRM é single-tenant
 *    por login — não existe troca de workspace).
 *  - A busca (⌘K) filtra de verdade os itens de navegação e navega ao selecionar, em
 *    vez de ser apenas decorativa.
 *  - Navegação usa os ids das rotas reais do app (ver App.tsx), não dados mock.
 */

export type NavItemData = {
  id: string;
  title: string;
  icon: React.ElementType;
  badge?: number | string;
  shortcut?: string;
  path?: string; // rota do react-router; ausente = item "de ação" (ex.: logout) ou apenas agrupador
  children?: NavItemData[];
};

export type NavGroupData = {
  heading?: string;
  items: NavItemData[];
};

function flattenItems(items: NavItemData[]): NavItemData[] {
  return items.reduce((acc, item) => {
    acc.push(item);
    if (item.children) acc.push(...flattenItems(item.children));
    return acc;
  }, [] as NavItemData[]);
}

function BrandHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="dsb-brand">
      <div className="dsb-brand-mark">{title.charAt(0)}</div>
      <div className="dsb-brand-text">
        <span className="dsb-brand-title">{title}</span>
        {subtitle && <span className="dsb-brand-subtitle">{subtitle}</span>}
      </div>
    </div>
  );
}

function NavItem({
  item,
  activeId,
  onSelect,
  level = 0,
}: {
  item: NavItemData;
  activeId: string;
  onSelect: (item: NavItemData) => void;
  level?: number;
}) {
  const isActive = activeId === item.id;
  const hasChildren = !!item.children?.length;
  const [isOpen, setIsOpen] = useState(false);

  function handleClick() {
    if (hasChildren) {
      setIsOpen((o) => !o);
    } else {
      onSelect(item);
    }
  }

  return (
    <div className="dsb-item-wrap">
      <div
        className={`dsb-item ${isActive ? "dsb-item-active" : ""}`}
        style={{ paddingLeft: 10 + level * 14 }}
        onClick={handleClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && handleClick()}
      >
        <span className="dsb-item-main">
          <item.icon className="dsb-item-icon" size={16} strokeWidth={1.5} />
          <span className="dsb-item-title">{item.title}</span>
        </span>
        <span className="dsb-item-meta">
          {item.shortcut && <kbd className="dsb-kbd">{item.shortcut}</kbd>}
          {item.badge !== undefined && <span className="badge">{item.badge}</span>}
          {hasChildren && (
            <ChevronRight
              size={14}
              className={`dsb-chevron ${isOpen ? "dsb-chevron-open" : ""}`}
              strokeWidth={2}
            />
          )}
        </span>
      </div>

      {hasChildren && isOpen && (
        <div className="dsb-children">
          {item.children!.map((child) => (
            <NavItem key={child.id} item={child} activeId={activeId} onSelect={onSelect} level={level + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function SearchPalette({
  items,
  onSelect,
  onClose,
}: {
  items: NavItemData[];
  onSelect: (item: NavItemData) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => i.title.toLowerCase().includes(q));
  }, [items, query]);

  return (
    <div className="dsb-palette-overlay" onClick={onClose}>
      <div className="dsb-palette card" onClick={(e) => e.stopPropagation()}>
        <div className="dsb-palette-input-row">
          <Search size={17} className="dsb-item-icon" strokeWidth={1.5} />
          <input
            autoFocus
            className="dsb-palette-input"
            placeholder="Buscar uma página..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "Enter" && results[0]) onSelect(results[0]);
            }}
          />
          <kbd className="dsb-kbd" onClick={onClose} style={{ cursor: "pointer" }}>
            ESC
          </kbd>
          <button className="dsb-icon-btn" onClick={onClose} aria-label="Fechar busca">
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>
        <div className="dsb-palette-results">
          {results.length === 0 && (
            <div className="dsb-palette-empty">
              <Command size={20} strokeWidth={1.5} />
              <p>Nada encontrado</p>
            </div>
          )}
          {results.map((item) => (
            <div key={item.id} className="dsb-palette-result" onClick={() => onSelect(item)}>
              <item.icon size={15} strokeWidth={1.5} />
              <span>{item.title}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function SidebarNav({
  groups,
  bottomItems,
  activeId,
  onSelect,
  brandTitle,
  brandSubtitle,
  collapsible = true,
}: {
  groups: NavGroupData[];
  bottomItems?: NavItemData[];
  activeId: string;
  onSelect: (item: NavItemData) => void;
  brandTitle: string;
  brandSubtitle?: string;
  collapsible?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);

  const allSearchableItems = useMemo(
    () => flattenItems([...groups.flatMap((g) => g.items), ...(bottomItems || [])]).filter((i) => i.path),
    [groups, bottomItems]
  );

  function handleSelect(item: NavItemData) {
    if (item.id === "search") {
      setSearchOpen(true);
      return;
    }
    onSelect(item);
  }

  return (
    <>
      {collapsible && (
        <button className="dsb-collapse-toggle" onClick={() => setIsOpen((o) => !o)} aria-label="Recolher/expandir menu">
          {isOpen ? <PanelLeftClose size={16} strokeWidth={1.5} /> : <PanelLeftOpen size={16} strokeWidth={1.5} />}
        </button>
      )}

      <div className={`dsb-sidebar ${isOpen ? "" : "dsb-sidebar-collapsed"}`}>
        <BrandHeader title={brandTitle} subtitle={brandSubtitle} />

        <div className="dsb-groups">
          {groups.map((group, idx) => (
            <div key={idx} className="dsb-group">
              {group.heading && <span className="dsb-group-heading">{group.heading}</span>}
              {group.items.map((item) => (
                <NavItem key={item.id} item={item} activeId={activeId} onSelect={handleSelect} />
              ))}
            </div>
          ))}
        </div>

        {bottomItems && bottomItems.length > 0 && (
          <div className="dsb-bottom">
            {bottomItems.map((item) => (
              <NavItem key={item.id} item={item} activeId={activeId} onSelect={handleSelect} />
            ))}
          </div>
        )}
      </div>

      {searchOpen && (
        <SearchPalette
          items={allSearchableItems}
          onSelect={(item) => {
            setSearchOpen(false);
            onSelect(item);
          }}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </>
  );
}
