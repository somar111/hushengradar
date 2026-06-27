export default function BioPage() {
  return (
    <div className="bio-page">
      <header className="bio-header">
        <h1 className="bio-title">产品经理自荐 ｜附独立产品 Demo</h1>
      </header>

      <p>你好：</p>

      <p>
        我是<span className="bio-name">阮好</span>。对贵司的产品经理岗位非常感兴趣，尤其关注
        AI 与工具类产品方向。
      </p>

      <ul className="bio-list">
        <li>教育经历：武大法学院-本科</li>
        <li>
          独立做的产品：<span className="bio-product-name">「呼声雷达」</span>
          <ul className="bio-sub-list">
            <li>
              landing page：<a href="https://hushengradar.com/">hushengradar.com</a>
            </li>
            <li>
              在线 Demo：<a href="https://hushengradar.com/demo">hushengradar.com/demo</a>
            </li>
          </ul>
        </li>
      </ul>

      <p>
        除此之外，我还有许多令人激动的 product ideas，非常渴望能和你们团队在实际业务中去碰撞和落地。
      </p>

      <p className="bio-tags-row">
        标签：
        <span className="bio-tags">
          <span className="bio-tag">快速学习</span>
          <span className="bio-tag">独立思考</span>
          <span className="bio-tag">High agency</span>
          <span className="bio-tag">热爱解决问题</span>
        </span>
      </p>

      <p className="bio-closing">
        欢迎随时点击 Demo 体验我的产品。如果团队目前有聊聊的机会，随时联系我！
      </p>

      <p className="bio-contact">
        联系邮箱： <a href="mailto:haoruan2@gmail.com">haoruan2@gmail.com</a>
        <br />
        微信 ID：renderbetter
      </p>
    </div>
  );
}
