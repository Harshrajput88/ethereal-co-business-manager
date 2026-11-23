import Icon from './Icon'

export default function TablePagination({ page, pageCount, total, pageSize, onPageChange }) {
  if (total <= pageSize) return null
  const start = (page - 1) * pageSize + 1
  const end = Math.min(page * pageSize, total)
  return (
    <div className="table-pagination">
      <span>Showing {start}–{end} of {total}</span>
      <div className="table-pagination-actions">
        <button type="button" className="button-ghost button-small" onClick={() => onPageChange(page - 1)} disabled={page <= 1}>
          <Icon name="chevron-left" size={14} /> Previous
        </button>
        <span>Page {page} of {pageCount}</span>
        <button type="button" className="button-ghost button-small" onClick={() => onPageChange(page + 1)} disabled={page >= pageCount}>
          Next <Icon name="chevron-right" size={14} />
        </button>
      </div>
    </div>
  )
}
