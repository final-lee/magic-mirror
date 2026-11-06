import { changeTitle } from "./changes";
import { RbacBatchDialog } from "./RbacBatchDialog";
import { useCart } from "./cart";
import * as t from "./text";
import { CART_MAX } from "./types";
import { useRbacBatch } from "./useRbacBatch";
import type { K8sChange, K8sTarget } from "../types";

interface Props {
  target: K8sTarget;
  ssoProfile: string;
  /** 일괄 적용에서 적용한 변경들(변경 기록과 접근 화면을 다시 읽는 데 쓴다) */
  onApplied: (changes: K8sChange[]) => void;
}

/**
 * 권한 변경 장바구니 막대와 한 번에 미리보기 창. 장바구니에 담긴 것이 있을 때만 막대가 보이고, 담은 변경을 펼쳐 보거나 뺄 수 있다.
 * 장바구니는 대상마다 있고 화면을 옮겨도 남는다(`cart.ts`).
 */
export function CartHost({ target, ssoProfile, onApplied }: Props) {
  const cart = useCart(target);
  const { batch, api } = useRbacBatch(target, ssoProfile, onApplied);
  return (
    <>
      {cart.changes.length > 0 && (
        <div className="rbac-cart" role="region" aria-label={t.CART_LABEL}>
          <b>{t.cartCount(cart.changes.length, CART_MAX)}</b>
          <details className="rbac-cart-items">
            <summary>{t.CART_ITEMS}</summary>
            <ul aria-label={t.CART_ITEMS}>
              {cart.changes.map((change, index) => {
                const title = changeTitle(change);
                return (
                  <li key={index}>
                    <span className="mono k8s-wrap">{title}</span>
                    <button className="link tone-ghost-danger" aria-label={t.cartRemoveLabel(title)} onClick={() => cart.remove(index)}>
                      {t.CART_REMOVE}
                    </button>
                  </li>
                );
              })}
            </ul>
          </details>
          <span className="rbac-cart-actions">
            <button className="btn tone-primary" disabled={batch !== null} onClick={() => api.start(cart.changes.map((change) => ({ change, undoOf: null })))}>
              {t.CART_PREVIEW}
            </button>
            <button className="btn tone-ghost-danger" onClick={cart.clear}>
              {t.CART_CLEAR}
            </button>
          </span>
        </div>
      )}
      {batch && <RbacBatchDialog batch={batch} api={api} />}
    </>
  );
}
