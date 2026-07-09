import { Icon } from "@/components/icons";

const benefits = [
  { icon: "check" as const, title: "Понятный flow", text: "Пользователь видит проверку ссылки, результат, качество и следующий шаг." },
  { icon: "shield" as const, title: "Правовой контроль", text: "Скачивание заблокировано, пока пользователь не подтвердит права на контент." },
  { icon: "lock" as const, title: "Без приватного доступа", text: "UI не просит cookies, логин, пароль или доступ к закрытым аккаунтам." },
  { icon: "bolt" as const, title: "Готов к API", text: "Компоненты подготовлены для подключения backend на следующем этапе." }
];

export function BenefitsSection() {
  return (
    <section className="bg-white px-5 py-16 sm:px-8 sm:py-20">
      <div className="mx-auto max-w-7xl">
        <div className="text-center">
          <p className="text-xs font-bold uppercase tracking-[.14em] text-brand">Преимущества</p>
          <h2 className="mt-3 text-3xl font-extrabold tracking-[-.05em] text-ink sm:text-4xl">Интерфейс без лишних обещаний</h2>
        </div>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {benefits.map((benefit) => (
            <article key={benefit.title} className="rounded-2xl border border-slate-100 bg-white p-5 shadow-card">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-blue-50 text-brand">
                <Icon name={benefit.icon} className="h-5 w-5" />
              </span>
              <h3 className="mt-5 text-base font-bold text-ink">{benefit.title}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-500">{benefit.text}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
