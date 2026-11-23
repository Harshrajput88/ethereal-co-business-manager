import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useApp } from '../AppContext'
import { useApiData } from '../hooks/useApiData'
import { formatDate, formatDateTime, formatMoney, formatNumber, titleCase } from '../lib/format'
import Icon from './Icon'
import InvoiceModal from './InvoiceView'
import ReturnModal from './ReturnModal'
import { ErrorNote, Field, InlineNote, LoadingBlock, Metric, Modal, StatusBadge } from './ui'

export default function SaleDetailModal({ open, onClose, saleId, focusInvoice = false }) {
  const app = useApp()
  const [invoiceOpen, setInvoiceOpen] = useState(false)
  const [returnOpen, setReturnOpen] = useState(false)
  const [decisionOpen, setDecisionOpen] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')

  const detail = useApiData(
    () => api.getSaleDetail(saleId),
    [saleId, app.version],
    { enabled: open && Boolean(saleId) }
  )

  useEffect(() => {
    if (open && focusInvoice) setInvoiceOpen(true)
    if (!open) setInvoiceOpen(false)
  }, [open, focusInvoice])

  const sale = detail.data

  async function decide(decision) {
    setActionError('')
    if (decision === 'reject' && !reason.trim()) {
      setActionError('Add a reason so the salesperson knows what to fix.')
      return
    }
    setBusy(true)
    try {
      await api.reviewCreditSale({ saleId, decision, reason })
      app.notify(
        decision === 'approve' ? 'Credit sale approved and confirmed.' : 'Credit sale rejected.',
        decision === 'approve' ? 'success' : 'warning'
      )
      setDecisionOpen('')
      setReason('')
      app.refresh()
      detail.reload({ quiet: true })
    } catch (error) {
      setActionError(error.message)
    } finally {
      setBusy(false)
    }
  }

  function closeAll() {
    setInvoiceOpen(false)
    setReturnOpen(false)
    setDecisionOpen('')
    setReason('')
    setActionError('')
    onClose()
  }

  return (
    <>
      <Modal
        open={open}
        onClose={closeAll}
        size="lg"
        title={sale ? `Sale #${sale.sale_number}` : 'Sale details'}
        subtitle={sale ? `${sale.shop?.name} · ${formatDate(sale.business_date)}` : undefined}
        footer={
          <>
            <button type="button" className="button-ghost" onClick={closeAll}>
              Close
            </button>
            {sale?.status === 'confirmed' && (
              <button type="button" className="button-secondary" onClick={() => setReturnOpen(true)}>
                <Icon name="returns" size={16} /> Request return
              </button>
            )}
            {sale?.invoice && (
              <button type="button" className="button-primary" onClick={() => setInvoiceOpen(true)}>
                <Icon name="invoices" size={16} /> View invoice
              </button>
            )}
          </>
        }
      >
        {detail.loading && <LoadingBlock label="Loading sale…" />}
        <ErrorNote message={detail.error} onRetry={detail.reload} />

        {sale && (
          <div className="stack-lg">
            <div className="detail-topline">
              <div className="detail-identity">
                <span className="detail-avatar">
                  <Icon name="sales" size={24} />
                </span>
                <div>
                  <strong>{sale.shop?.name || 'Unknown shop'}</strong>
                  <p>
                    Recorded by {sale.salesperson?.name || '—'} · {formatDate(sale.business_date)}
                  </p>
                </div>
              </div>
              <StatusBadge status={sale.status} />
            </div>

            {sale.status === 'pending_credit_approval' && (
              <InlineNote tone="warning">
                <strong>Waiting for credit approval.</strong> Stock is reserved only after an owner or
                admin approves this sale.
              </InlineNote>
            )}

            {sale.status === 'rejected' && (
              <InlineNote tone="danger">
                This sale was rejected. {sale.rejection_reason || 'No reason was recorded.'}
              </InlineNote>
            )}

            <div className="metric-row">
              <Metric label="Grand total" value={formatMoney(sale.grand_total)} />
              <Metric label="Verified paid" value={formatMoney(sale.paid)} />
              <Metric label="Balance" value={formatMoney(sale.balance)} />
              <Metric label="Terms" value={titleCase(sale.payment_terms)} />
            </div>

            <section>
              <h3 className="subhead">Products</h3>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th className="num">Cartons</th>
                      <th className="num">Bottles</th>
                      <th className="num">Rate</th>
                      <th className="num">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sale.lines.map(line => (
                      <tr key={line.id}>
                        <td>
                          <strong>{line.product_name}</strong>
                          <small>{line.sku}</small>
                        </td>
                        <td className="num">{formatNumber(line.cartons)}</td>
                        <td className="num">
                          {formatNumber(line.cartons * line.bottles_per_carton)}
                        </td>
                        <td className="num">{formatMoney(line.unit_price)}</td>
                        <td className="num">{formatMoney(line.line_total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <div className="split-grid">
              <section>
                <h3 className="subhead">Payments</h3>
                {sale.payments.length ? (
                  <ul className="mini-list">
                    {sale.payments.map(payment => (
                      <li key={payment.id}>
                        <div>
                          <strong>{formatMoney(payment.allocated)}</strong>
                          <span>
                            {titleCase(payment.method)} · {formatDate(payment.received_at)}
                          </span>
                        </div>
                        <StatusBadge status={payment.status} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted-copy">No payment has been applied to this sale yet.</p>
                )}
              </section>
              <section>
                <h3 className="subhead">Returns</h3>
                {sale.returns.length ? (
                  <ul className="mini-list">
                    {sale.returns.map(request => (
                      <li key={request.id}>
                        <div>
                          <strong>
                            {request.lines.reduce(
                              (total, line) => total + Number(line.approved_cartons || line.cartons || 0),
                              0
                            )}{' '}
                            cartons
                          </strong>
                          <span>
                            {titleCase(request.status)} · {formatDateTime(request.submitted_at)}
                          </span>
                        </div>
                        <StatusBadge status={request.status} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted-copy">No return requests for this sale.</p>
                )}
              </section>
            </div>

            {sale.invoice && (
              <div className="invoice-strip">
                <Icon name="invoices" size={18} />
                <span>
                  Invoice <strong>{sale.invoice.invoice_number}</strong> issued{' '}
                  {formatDate(sale.invoice.issued_at)}
                </span>
                <button type="button" className="link-button" onClick={() => setInvoiceOpen(true)}>
                  Open <Icon name="arrow" size={14} />
                </button>
              </div>
            )}

            {app.isAdmin && sale.status === 'pending_credit_approval' && (
              <section className="decision-panel">
                <div>
                  <h3 className="subhead">Credit decision</h3>
                  <p className="muted-copy">
                    Approving reserves stock, issues the invoice and records the credit balance.
                  </p>
                </div>
                {decisionOpen === 'reject' && (
                  <Field label="Rejection reason" htmlFor="credit-reject-reason">
                    <textarea
                      id="credit-reject-reason"
                      rows="2"
                      value={reason}
                      onChange={event => setReason(event.target.value)}
                      placeholder="e.g. Payment history is overdue"
                    />
                  </Field>
                )}
                <ErrorNote message={actionError} />
                <div className="button-row">
                  {decisionOpen === 'reject' ? (
                    <>
                      <button
                        type="button"
                        className="button-ghost"
                        onClick={() => {
                          setDecisionOpen('')
                          setReason('')
                          setActionError('')
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="button-danger"
                        disabled={busy}
                        onClick={() => decide('reject')}
                      >
                        Confirm rejection
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="button-secondary"
                        onClick={() => setDecisionOpen('reject')}
                      >
                        Reject
                      </button>
                      <button
                        type="button"
                        className="button-primary"
                        disabled={busy}
                        onClick={() => decide('approve')}
                      >
                        <Icon name="check" size={16} /> Approve credit sale
                      </button>
                    </>
                  )}
                </div>
              </section>
            )}
          </div>
        )}
      </Modal>

      <InvoiceModal open={invoiceOpen} onClose={() => setInvoiceOpen(false)} detail={sale} />
      <ReturnModal
        open={returnOpen}
        onClose={() => setReturnOpen(false)}
        saleId={saleId}
        onSubmitted={() => {
          setReturnOpen(false)
          app.refresh()
          detail.reload({ quiet: true })
        }}
      />
    </>
  )
}
