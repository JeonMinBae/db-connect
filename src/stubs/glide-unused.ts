// Glide Data Grid가 정적으로 가져오지만 이 앱은 쓰지 않는 셀(마크다운·이미지)의 의존성 대체품.
// vite.config.ts의 resolve.alias로 연결한다. 번들에서 marked와 carousel을 빼기 위함.
export const marked = (s: string) => s;
export const Carousel = () => null;
