import Layout, { PageHeader } from '../components/Layout'
import ContractDeals from '../components/ContractDeals'

// Eigen pagina voor de koopjesjacht: publieke item-exchange-contracten in
// The Forge die onder de Jita-prijs staan. De inhoud zit in het losse
// ContractDeals-component (dat ook z'n eigen ververs-knop meebrengt).
export default function Koopjes() {
  return (
    <Layout header={
      <PageHeader
        title="Koopjes"
        sub="publieke contracten onder de Jita-prijs"
      />
    }>
      <ContractDeals />
    </Layout>
  )
}
