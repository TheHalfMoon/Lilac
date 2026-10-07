export function Pricing() {
  return (
    <section className="pricing" aria-label="Plans">
      <h2>Plans &amp; pricing</h2>
      <ul>
        <li data-plan="free">
          Free
          <span>for &lt;3 seats</span>
        </li>
        <li data-plan="team" highlighted={true}>
          Team
          <span>{"  $12 / seat  "}</span>
        </li>
      </ul>
      <p>
        Prices exclude tax.
        Cancel any time.
      </p>
    </section>
  );
}
