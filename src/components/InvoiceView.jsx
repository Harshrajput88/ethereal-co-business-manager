import Icon from './Icon'
import { Modal } from './ui'
import { formatDate, formatMoney, formatNumber, titleCase } from '../lib/format'

function addressLines(person, buyer = false) {
  if (!person) return []
  if (buyer) {
    return [
      person.address_line1,
      person.address_line2,
      [person.locality, person.city].filter(Boolean).join(', '),
      [person.state, person.postal_code].filter(Boolean).join(' ')
    ].filter(Boolean)
  }
  return [person.address].filter(Boolean)
}

export default function InvoiceModal({ open, onClose, detail }) {
  if (!open || !detail) return null
  const invoice = detail.invoice
  const seller = invoice?.seller || {}
  const buyer = invoice?.buyer || detail.shop || {}

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      className="invoice-modal"
      title={`Invoice ${invoice?.invoice_number || ''}`}
      subtitle={invoice ? `Issued ${formatDate(invoice.issued_at)}` : 'Invoice not available'}
      footer={
        <>
          <button type="button" className="button-ghost" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="button-primary"
            onClick={() => window.print()}
            disabled={!invoice}
          >
            <Icon name="print" size={16} /> Print / Save as PDF
          </button>
        </>
      }
    >
      {!invoice ? (
        <div className="inline-note note-warning">
          <Icon name="clock" size={18} />
          <div>This sale does not have an invoice yet. Credit sales receive one after approval.</div>
        </div>
      ) : (
        <article className="invoice-sheet print-area">
          <header className="invoice-head">
            <div>
              <p className="invoice-kicker">Tax invoice</p>
              <h2>{seller.name || 'Ethereal Co.'}</h2>
              {seller.tagline && <p className="invoice-tagline">{seller.tagline}</p>}
              <address>
                {addressLines(seller).map(line => (
                  <span key={line}>{line}</span>
                ))}
                {seller.phone && <span>{seller.phone}</span>}
                {seller.email && <span>{seller.email}</span>}
                {seller.gstin && <span>GSTIN: {seller.gstin}</span>}
              </address>
            </div>
            <div className="invoice-meta">
              <span className="invoice-mark">ETC</span>
              <dl>
                <div>
                  <dt>Invoice no.</dt>
                  <dd>{invoice.invoice_number}</dd>
                </div>
                <div>
                  <dt>Invoice date</dt>
                  <dd>{formatDate(invoice.issued_at)}</dd>
                </div>
                <div>
                  <dt>Sale no.</dt>
                  <dd>#{detail.sale_number}</dd>
                </div>
                <div>
                  <dt>Terms</dt>
                  <dd>{titleCase(detail.payment_terms)}</dd>
                </div>
              </dl>
            </div>
          </header>

          <section className="invoice-parties">
            <div>
              <h3>Billed to</h3>
              <strong>{buyer.name}</strong>
              <address>
                {addressLines(buyer, true).map(line => (
                  <span key={line}>{line}</span>
                ))}
                {buyer.phone && <span>{buyer.phone}</span>}
                {buyer.email && <span>{buyer.email}</span>}
              </address>
            </div>
            <div>
              <h3>Recorded by</h3>
              <strong>{detail.salesperson?.name || '—'}</strong>
              <p>{titleCase(detail.status)} sale</p>
              <p>Business date {formatDate(detail.business_date)}</p>
            </div>
          </section>

          <table className="invoice-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Product</th>
                <th>SKU</th>
                <th className="num">Cartons</th>
                <th className="num">Bottles</th>
                <th className="num">Rate / carton</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((line, index) => (
                <tr key={`${line.sku}-${index}`}>
                  <td>{index + 1}</td>
                  <td>
                    <strong>{line.product_name}</strong>
                  </td>
                  <td>{line.sku}</td>
                  <td className="num">{formatNumber(line.cartons)}</td>
                  <td className="num">{formatNumber(line.cartons * line.bottles_per_carton)}</td>
                  <td className="num">{formatMoney(line.unit_price)}</td>
                  <td className="num">{formatMoney(line.line_total)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <section className="invoice-totals">
            <div className="invoice-notes">
              <p>
                <strong>Payment terms:</strong> {titleCase(detail.payment_terms)}
              </p>
              <p>{invoice.tax_mode === 'non_gst' ? 'Non-GST invoice.' : 'GST invoice.'} Prices in INR.</p>
              {detail.balance > 0 && <p>Balance due: {formatMoney(detail.balance)}</p>}
            </div>
            <dl>
              <div>
                <dt>Subtotal</dt>
                <dd>{formatMoney(invoice.subtotal)}</dd>
              </div>
              <div>
                <dt>Tax</dt>
                <dd>{formatMoney(0)}</dd>
              </div>
              <div className="grand">
                <dt>Grand total</dt>
                <dd>{formatMoney(invoice.grand_total)}</dd>
              </div>
              <div>
                <dt>Verified payments</dt>
                <dd>{formatMoney(detail.paid)}</dd>
              </div>
              <div>
                <dt>Balance</dt>
                <dd>{formatMoney(detail.balance)}</dd>
              </div>
            </dl>
          </section>

          <footer className="invoice-foot">
            <p>Thank you for choosing Ethereal Co.</p>
            <span>This is a computer-generated invoice. {seller.name || 'Ethereal Co.'}</span>
          </footer>
        </article>
      )}
    </Modal>
  )
}
