import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";

type SectionDestination = {
  href: string;
  label: string;
  description: string;
  icon: LucideIcon;
};

export function SectionLanding({
  title,
  description,
  destinations,
}: {
  title: string;
  description: string;
  destinations: SectionDestination[];
}) {
  return <div className="page-stack section-landing">
    <section className="page-heading-row section-landing-heading">
      <div>
        <h1>{title}</h1>
        <p className="subtitle">{description}</p>
      </div>
    </section>
    <nav className="section-destinations" aria-label={`${title} sections`}>
      {destinations.map(({ href, label, description: detail, icon: Icon }) => <Link className="section-destination" href={href} key={href}>
        <span className="section-destination-icon"><Icon size={19} strokeWidth={1.8} aria-hidden="true"/></span>
        <span className="section-destination-copy"><strong>{label}</strong><span>{detail}</span></span>
        <ArrowRight className="section-destination-arrow" size={17} aria-hidden="true"/>
      </Link>)}
    </nav>
  </div>;
}
