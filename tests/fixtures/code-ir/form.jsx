const SignIn = () => (
  <form className='stack gap-2' data-testid="sign-in">
    <label htmlFor="email">Email &#40;work&#41;</label>
    <input id="email" type="email" required maxLength={254} />
    <button type="submit" title={"Sign in \"now\""}>Sign in</button>
  </form>
);
